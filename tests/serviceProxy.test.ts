import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_API_CREDENTIALS_TYPES } from '../src/apiCredentials/serialization.js';
import { ApiCredentialStore } from '../src/apiCredentials/store.js';
import { registerCommands, type CliDependencies } from '../src/cliCommands.js';
import { Config } from '../src/config.js';
import {
  buildCurlDryRunReport,
  prepareCurlInvocation,
  RequestNotPermittedError,
  type CurlInjectionDependencies,
} from '../src/curlInjection.js';
import { EncryptedStorage } from '../src/encryptedStorage.js';
import { derivePermissionsOverrideSigningKey } from '../src/gateway/permissionsOverride.js';
import { startGateway, type GatewayServer } from '../src/gateway/server.js';
import { configureServiceProxy, InvalidProxyConfigurationError } from '../src/serviceProxy.js';
import { ServiceRegistry } from '../src/serviceRegistry.js';
import {
  buildRegisteredServiceOptions,
  RegisteredService,
} from '../src/services/core/registered.js';

const KEY = 'dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3Q=';
const PROXY = 'socks5h://user:secret@proxy.example:1080';
const TARGET = 'https://api.example.com/test';
class TestExit extends Error {}

afterEach(() => vi.unstubAllEnvs());

describe('configureServiceProxy', () => {
  it.each([
    'http://localhost:8080',
    'https://localhost:443',
    'socks4://localhost:1080',
    'socks4a://localhost:1080',
    'socks5://localhost:1080',
    PROXY,
  ])('preserves the configured URL %s', (proxy) => {
    vi.stubEnv('TEST_SERVICE_PROXY', proxy);
    const arguments_ = Object.freeze([
      '--proxy',
      'http://caller:80',
      '--noproxy',
      '*',
      '--',
      TARGET,
    ]);
    const environment = { ...process.env };
    expect(configureServiceProxy(arguments_, 'TEST_SERVICE_PROXY', 'example')).toEqual([
      '--proxy',
      'http://caller:80',
      '--noproxy',
      '*',
      '--proxy',
      proxy,
      '--noproxy',
      '',
      '--',
      TARGET,
    ]);
    expect(process.env).toEqual(environment);
    expect(arguments_).toEqual(['--proxy', 'http://caller:80', '--noproxy', '*', '--', TARGET]);
  });

  it.each([undefined, '', '   ', 'not-a-url-secret', 'ftp://secret@example.com', 'http://'])(
    'rejects invalid proxy values without exposing them',
    (value) => {
      vi.stubEnv('TEST_SERVICE_PROXY', value);
      try {
        configureServiceProxy([TARGET], 'TEST_SERVICE_PROXY', 'example');
        expect.fail('expected invalid proxy configuration');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidProxyConfigurationError);
        if (value?.trim()) expect((error as Error).message).not.toContain(value);
      }
    }
  );

  it.each(['', '1BAD', 'BAD-NAME', 'BAD=NAME'])('rejects invalid variable name %j', (name) => {
    expect(() => configureServiceProxy([TARGET], name, 'example')).toThrow(
      InvalidProxyConfigurationError
    );
  });

  it('appends options when there is no end marker', () => {
    vi.stubEnv('TEST_SERVICE_PROXY', PROXY);
    expect(configureServiceProxy([TARGET], 'TEST_SERVICE_PROXY', 'example')).toEqual([
      TARGET,
      '--proxy',
      PROXY,
      '--noproxy',
      '',
    ]);
    expect(
      buildRegisteredServiceOptions(undefined, undefined, undefined, 'TEST_SERVICE_PROXY')
    ).toEqual({ proxyEnv: 'TEST_SERVICE_PROXY' });
  });
});

describe('service proxy routing', () => {
  let directory: string;
  let storage: EncryptedStorage;
  let gateway: GatewayServer | undefined;
  const first = new RegisteredService('first', 'https://api.example.com/', {
    proxyEnv: 'FIRST_PROXY_TEST',
  });
  const second = new RegisteredService('second', 'https://api.example.com/', {
    proxyEnv: 'SECOND_PROXY_TEST',
  });
  const plain = new RegisteredService('plain', 'https://plain.example.com/');
  const credential = {
    objectType: 'rawCurl',
    curlArguments: ['-H', 'Authorization: Bearer credential-secret'],
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'latchkey-service-proxy-'));
    storage = new EncryptedStorage(KEY);
    vi.stubEnv('FIRST_PROXY_TEST', PROXY);
    vi.stubEnv('SECOND_PROXY_TEST', 'http://second-proxy:8080');
  });

  afterEach(async () => {
    if (gateway !== undefined) await gateway.close();
    gateway = undefined;
    rmSync(directory, { recursive: true, force: true });
  });

  function store(credentials: Record<string, unknown>): ApiCredentialStore {
    const path = join(directory, 'credentials.json.enc');
    storage.writeFile(
      path,
      JSON.stringify({
        credentials: Object.fromEntries(
          Object.entries(credentials).map(([name, value]) => [name, { '': value }])
        ),
      })
    );
    return new ApiCredentialStore(path, storage);
  }

  function dependencies(
    overrides: Partial<CurlInjectionDependencies> = {}
  ): CurlInjectionDependencies {
    return {
      registry: new ServiceRegistry([first, second, plain]),
      passthroughUnknown: false,
      credentialsRefreshDisabled: true,
      diagnosticHeaders: false,
      checkPermission: () => Promise.resolve(true),
      permissionsConfigPath: join(directory, 'permissions.json'),
      permissionsDoNotUseBuiltinSchemas: false,
      ...overrides,
    };
  }

  async function runCli(gatewayUrl?: string): Promise<{
    calls: readonly string[][];
    errors: readonly string[];
    exitCode: number | undefined;
  }> {
    const calls: string[][] = [];
    const errors: string[] = [];
    let exitCode: number | undefined;
    const config = new Config((name) => {
      if (name === 'LATCHKEY_DIRECTORY') return directory;
      if (name === 'LATCHKEY_ENCRYPTION_KEY') return KEY;
      if (name === 'LATCHKEY_GATEWAY') return gatewayUrl;
      return undefined;
    });
    const deps: CliDependencies = {
      baseServices: [first],
      registry: new ServiceRegistry([first]),
      apiCredentialsTypes: BUILTIN_API_CREDENTIALS_TYPES,
      config,
      runCurl: (args) => {
        calls.push([...args]);
        return { returncode: 0, stdout: '', stderr: '' };
      },
      runCurlAsync: () => Promise.resolve({ returncode: 0, stdout: Buffer.from(''), stderr: '' }),
      checkPermission: () => Promise.resolve(true),
      confirm: () => Promise.resolve(true),
      readStdin: () => Promise.resolve(''),
      exit: (code) => {
        exitCode = code;
        throw new TestExit();
      },
      log: () => undefined,
      errorLog: (message) => errors.push(message),
      version: 'test',
    };
    const program = new Command();
    program.exitOverride();
    registerCommands(program, deps);
    try {
      await program.parseAsync(['node', 'latchkey', 'curl', TARGET]);
    } catch (error) {
      if (!(error instanceof TestExit)) throw error;
    }
    return { calls, errors, exitCode };
  }

  it('passes the configured proxy to curl and exits cleanly when it is missing', async () => {
    store({ first: credential });
    const success = await runCli();
    expect(success.exitCode).toBe(0);
    expect(success.errors).toEqual([]);
    expect(success.calls).toHaveLength(1);
    expect(success.calls[0]).toContain(PROXY);
    expect(success.calls[0]?.slice(-4)).toEqual(['--proxy', PROXY, '--noproxy', '']);

    vi.stubEnv('FIRST_PROXY_TEST', undefined);
    const failure = await runCli();
    expect(failure.exitCode).toBe(1);
    expect(failure.errors.join(' ')).toContain('FIRST_PROXY_TEST');
    expect(failure.calls).toEqual([]);
  });

  it.each([undefined, 'invalid-local-proxy'])(
    'rewrites the CLI gateway hop without consulting the local service proxy',
    async (proxy) => {
      vi.stubEnv('FIRST_PROXY_TEST', proxy);
      const result = await runCli('http://gateway.example:1989');
      expect(result.exitCode).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toContain(`http://gateway.example:1989/gateway/${TARGET}`);
      expect(result.calls[0]).not.toContain('--proxy');
      expect(result.calls[0]).not.toContain('--noproxy');
    }
  );

  it('forces real curl through the configured HTTP proxy despite caller bypass options', async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      response.end('proxied');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new TestExit('missing proxy address');
      vi.stubEnv('FIRST_PROXY_TEST', `http://127.0.0.1:${String(address.port)}`);
      const target = 'http://unreachable.invalid/test';
      const args = configureServiceProxy(
        ['--silent', '--show-error', '--max-time', '3', '--proxy', '', target],
        'FIRST_PROXY_TEST',
        'first'
      );
      const run = promisify(execFile);
      const environment = { ...process.env, NO_PROXY: '*', no_proxy: '*' };
      const result = await run('curl', [...args], { env: environment });
      expect(result.stdout).toBe('proxied');
      expect(requests).toEqual([target]);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await expect(run('curl', [...args], { env: environment })).rejects.toMatchObject({ code: 7 });
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
      }
    }
  });

  it('uses the proxy of the overlapping service that supplied credentials', async () => {
    const args = Object.freeze([TARGET]);
    const result = await prepareCurlInvocation(args, store({ second: credential }), dependencies());
    expect(result.injectedServiceName).toBe('second');
    expect(result.proxyEnv).toBe('SECOND_PROXY_TEST');
    expect(result.curlArguments.slice(-4)).toEqual([
      '--proxy',
      'http://second-proxy:8080',
      '--noproxy',
      '',
    ]);
    expect(args).toEqual([TARGET]);
  });

  it('routes a known service without credentials through the first candidate on passthrough', async () => {
    const result = await prepareCurlInvocation(
      [TARGET],
      store({}),
      dependencies({ passthroughUnknown: true })
    );
    expect(result.injectedServiceName).toBeNull();
    expect(result.proxyEnv).toBe('FIRST_PROXY_TEST');
    expect(result.curlArguments.slice(-4)).toEqual(['--proxy', PROXY, '--noproxy', '']);
    expect(buildCurlDryRunReport(result)).toEqual({
      credentialsInjected: false,
      service: null,
      proxyEnv: 'FIRST_PROXY_TEST',
    });
  });

  it('leaves unknown and unconfigured services unchanged', async () => {
    const unknown = ['https://unknown.example.org/'];
    const untouched = await prepareCurlInvocation(
      unknown,
      store({}),
      dependencies({ passthroughUnknown: true })
    );
    expect(untouched.curlArguments).toEqual(unknown);
    expect(buildCurlDryRunReport(untouched)).toEqual({ credentialsInjected: false, service: null });
    const unconfigured = await prepareCurlInvocation(
      ['https://plain.example.com/'],
      store({}),
      dependencies({ passthroughUnknown: true })
    );
    expect(unconfigured.curlArguments).toEqual(['https://plain.example.com/']);
    expect(unconfigured.proxyEnv).toBeUndefined();
  });

  it('checks permissions before consulting proxy configuration', async () => {
    vi.stubEnv('FIRST_PROXY_TEST', 'invalid-secret');
    await expect(
      prepareCurlInvocation(
        [TARGET],
        store({ first: credential }),
        dependencies({ checkPermission: () => Promise.resolve(false) })
      )
    ).rejects.toBeInstanceOf(RequestNotPermittedError);
  });

  it('dry-run exposes only the variable name, never proxy or credential secrets', async () => {
    const result = await prepareCurlInvocation(
      [TARGET],
      store({ first: credential }),
      dependencies()
    );
    const report = buildCurlDryRunReport(result);
    expect(report).toEqual({
      credentialsInjected: true,
      service: 'first',
      proxyEnv: 'FIRST_PROXY_TEST',
    });
    expect(JSON.stringify(report)).not.toContain(PROXY);
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('isolates simultaneous preparations for different services', async () => {
    const other = new RegisteredService('other', 'https://other.example.com/', {
      proxyEnv: 'SECOND_PROXY_TEST',
    });
    const credentialStore = store({ first: credential, other: credential });
    const settings = dependencies({ registry: new ServiceRegistry([first, other]) });
    const environment = { ...process.env };
    const [one, two] = await Promise.all([
      prepareCurlInvocation([TARGET], credentialStore, settings),
      prepareCurlInvocation(['https://other.example.com/'], credentialStore, settings),
    ]);
    expect(one.curlArguments).toContain(PROXY);
    expect(one.curlArguments).not.toContain('http://second-proxy:8080');
    expect(two.curlArguments).toContain('http://second-proxy:8080');
    expect(two.curlArguments).not.toContain(PROXY);
    expect(process.env).toEqual(environment);
  });

  async function start(): Promise<{ url: string; calls: readonly string[][] }> {
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify({
        registeredServices: {
          first: { baseApiUrl: 'https://api.example.com/', proxyEnv: 'FIRST_PROXY_TEST' },
        },
      })
    );
    const credentialStore = store({ first: credential });
    const calls: string[][] = [];
    const config = new Config((name) =>
      name === 'LATCHKEY_DIRECTORY'
        ? directory
        : name === 'LATCHKEY_ENCRYPTION_KEY'
          ? KEY
          : undefined
    );
    const deps: CliDependencies = {
      baseServices: [],
      registry: new ServiceRegistry([]),
      apiCredentialsTypes: BUILTIN_API_CREDENTIALS_TYPES,
      config,
      runCurl: () => ({ returncode: 0, stdout: '', stderr: '' }),
      runCurlAsync: (args) => {
        calls.push([...args]);
        const index = args.indexOf('-D');
        if (index !== -1) writeFileSync(args[index + 1]!, 'HTTP/1.1 200 OK\r\n\r\n');
        return Promise.resolve({ returncode: 0, stdout: Buffer.from('ok'), stderr: '' });
      },
      checkPermission: () => Promise.resolve(true),
      confirm: () => Promise.resolve(true),
      readStdin: () => Promise.resolve(''),
      exit: () => {
        throw new TestExit();
      },
      log: () => undefined,
      errorLog: () => undefined,
      version: 'test',
    };
    gateway = await startGateway(deps, credentialStore, storage, {
      port: 0,
      host: 'localhost',
      maxBodySize: 1024 * 1024,
      password: null,
      permissionsOverrideSigningKey: derivePermissionsOverrideSigningKey(KEY),
    });
    const address = gateway.server.address();
    if (address === null || typeof address === 'string')
      throw new TestExit('missing gateway address');
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    return { url: `http://${host}:${String(address.port)}`, calls };
  }

  function dryRun(url: string): Promise<Response> {
    return fetch(`${url}/latchkey/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'curl dry-run',
        params: { method: 'GET', url: TARGET, headers: {}, bodyBase64: null },
      }),
    });
  }

  it('applies proxy routing upstream and reports only metadata in gateway dry-run', async () => {
    const { url, calls } = await start();
    const response = await fetch(`${url}/gateway/${TARGET}`);
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(PROXY);
    expect(calls[0]).toContain('--noproxy');
    const dryResponse = await dryRun(url);
    expect(dryResponse.status).toBe(200);
    const text = await dryResponse.text();
    expect(text).toContain('FIRST_PROXY_TEST');
    expect(text).not.toContain(PROXY);
    expect(text).not.toContain('credential-secret');
    expect(calls).toHaveLength(1);
  });

  it('returns 400 without invoking curl for invalid gateway proxy settings', async () => {
    const { url, calls } = await start();
    vi.stubEnv('FIRST_PROXY_TEST', 'ftp://user:proxy-secret@host');
    const response = await fetch(`${url}/gateway/${TARGET}`);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('proxy-secret');
    const dryResponse = await dryRun(url);
    expect(dryResponse.status).toBe(400);
    expect(await dryResponse.text()).not.toContain('proxy-secret');
    expect(calls).toEqual([]);
  });

  it('rejects malformed config changes without crashing the gateway or forwarding directly', async () => {
    const { url, calls } = await start();
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify({
        registeredServices: {
          first: { baseApiUrl: 'https://api.example.com/', proxyEnv: 123 },
        },
      })
    );
    expect((await fetch(`${url}/gateway/${TARGET}`)).status).toBe(400);
    expect((await dryRun(url)).status).toBe(400);
    expect((await fetch(url)).status).toBe(200);
    expect(calls).toEqual([]);
  });
});

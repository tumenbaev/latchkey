import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerCommands, type CliDependencies } from '../src/cliCommands.js';
import { Config } from '../src/config.js';
import { loadRegisteredServices } from '../src/configDataStore.js';
import {
  ServiceRegistry,
  loadRegisteredServicesIntoServiceRegistry,
} from '../src/serviceRegistry.js';
import { InvalidProxyConfigurationError } from '../src/serviceProxy.js';
import { RegisteredService } from '../src/services/core/registered.js';
import { GITHUB } from '../src/services/github.js';

class TestExit extends Error {}

describe('service proxy configuration', () => {
  let directory: string;
  let config: Config;
  let errors: string[];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'latchkey-proxy-config-'));
    config = new Config((name) => (name === 'LATCHKEY_DIRECTORY' ? directory : undefined));
    errors = [];
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  async function run(args: string[], registry: ServiceRegistry, gateway = false): Promise<void> {
    const dependencies = {
      registry,
      config: gateway
        ? new Config((name) => {
            if (name === 'LATCHKEY_DIRECTORY') return directory;
            if (name === 'LATCHKEY_GATEWAY') return 'http://localhost:1989';
            return undefined;
          })
        : config,
      exit: () => {
        throw new TestExit();
      },
      log: () => undefined,
      errorLog: (message: string) => errors.push(message),
    } as unknown as CliDependencies;
    const program = new Command();
    program.exitOverride();
    registerCommands(program, dependencies);
    try {
      await program.parseAsync(['node', 'latchkey', ...args]);
    } catch (error) {
      if (!(error instanceof TestExit)) throw error;
    }
  }

  it('registers, loads, updates and clears without discarding other fields', async () => {
    const registry = new ServiceRegistry([]);
    await run(
      [
        'services',
        'register',
        'example',
        '--base-api-url',
        'https://example.com/',
        '--proxy-env',
        'FIRST_PROXY',
      ],
      registry
    );
    expect(loadRegisteredServices(config.configPath).get('example')?.proxyEnv).toBe('FIRST_PROXY');
    const loaded = new ServiceRegistry([]);
    loadRegisteredServicesIntoServiceRegistry(config.configPath, loaded);
    expect((loaded.getByName('example') as RegisteredService).proxyEnv).toBe('FIRST_PROXY');
    const raw = JSON.parse(readFileSync(config.configPath, 'utf8')) as {
      registeredServices: Record<string, Record<string, unknown>>;
    };
    raw.registeredServices.example!.futureField = { preserved: true };
    writeFileSync(config.configPath, JSON.stringify(raw));
    await run(['services', 'proxy', 'example', '--proxy-env', 'SECOND_PROXY'], loaded);
    await run(['services', 'proxy', 'example', '--clear'], loaded);
    const updated = JSON.parse(readFileSync(config.configPath, 'utf8')) as typeof raw;
    expect(updated.registeredServices.example).toEqual({
      baseApiUrl: 'https://example.com/',
      futureField: { preserved: true },
    });
  });

  it.each(['bad-name', '', '1PROXY', 3, null, {}])(
    'rejects malformed persisted proxyEnv %j',
    (proxyEnv) => {
      writeFileSync(
        config.configPath,
        JSON.stringify({
          registeredServices: { example: { baseApiUrl: 'https://example.com/', proxyEnv } },
        })
      );
      expect(() => loadRegisteredServices(config.configPath)).toThrow(
        InvalidProxyConfigurationError
      );
    }
  );

  it('rejects bad names, built-ins, missing/conflicting options and gateway mutation', async () => {
    const registry = new ServiceRegistry([GITHUB]);
    await run(
      [
        'services',
        'register',
        'example',
        '--base-api-url',
        'https://example.com/',
        '--proxy-env',
        'bad-name',
      ],
      registry
    );
    await run(['services', 'proxy', 'github', '--proxy-env', 'PROXY'], registry);
    await run(['services', 'proxy', 'missing', '--clear'], registry);
    await run(['services', 'proxy', 'github'], registry);
    await run(['services', 'proxy', 'github', '--proxy-env', 'PROXY', '--clear'], registry);
    await run(['services', 'proxy', 'github', '--clear'], registry, true);
    expect(errors).toHaveLength(6);
    expect(loadRegisteredServices(config.configPath).size).toBe(0);
  });
});

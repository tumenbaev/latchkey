export class InvalidProxyConfigurationError extends Error {
  constructor(serviceName: string, detail: string) {
    super(`Invalid proxy configuration for service '${serviceName}': ${detail}`);
    this.name = 'InvalidProxyConfigurationError';
  }
}

export function validateProxyEnvironmentVariable(proxyEnv: string, serviceName: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(proxyEnv)) {
    throw new InvalidProxyConfigurationError(
      serviceName,
      'proxyEnv must be an environment variable name.'
    );
  }
}

const PROXY_PROTOCOLS: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'socks4:',
  'socks4a:',
  'socks5:',
  'socks5h:',
]);

export function configureServiceProxy(
  curlArguments: readonly string[],
  proxyEnv: string,
  serviceName: string
): readonly string[] {
  validateProxyEnvironmentVariable(proxyEnv, serviceName);
  const proxyUrl = process.env[proxyEnv];
  if (proxyUrl === undefined || proxyUrl.trim() === '') {
    throw new InvalidProxyConfigurationError(
      serviceName,
      `environment variable '${proxyEnv}' is unset or empty.`
    );
  }
  let parsedProxyUrl: URL;
  try {
    parsedProxyUrl = new URL(proxyUrl);
  } catch {
    throw new InvalidProxyConfigurationError(
      serviceName,
      `environment variable '${proxyEnv}' must contain a proxy URL.`
    );
  }
  if (!PROXY_PROTOCOLS.has(parsedProxyUrl.protocol) || parsedProxyUrl.hostname === '') {
    throw new InvalidProxyConfigurationError(
      serviceName,
      `environment variable '${proxyEnv}' must contain an HTTP(S) or SOCKS proxy URL.`
    );
  }

  // Last proxy options win, including over NO_PROXY. Keep options before curl's
  // end-of-options marker when the caller supplied one.
  const endOfOptions = curlArguments.indexOf('--');
  const insertionIndex = endOfOptions === -1 ? curlArguments.length : endOfOptions;
  return [
    ...curlArguments.slice(0, insertionIndex),
    '--proxy',
    proxyUrl,
    '--noproxy',
    '',
    ...curlArguments.slice(insertionIndex),
  ];
}

const { Readable } = require('node:stream');
const { createHmac } = require('node:crypto');

const config = {
  api: {
    bodyParser: false,
  },
  maxDuration: 60,
};

const hopByHopHeaders = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

async function readRequestBody(request, maximumBytes) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > maximumBytes) {
      throw new RangeError('Request body exceeds the allowed size.');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function proxy(request, response) {
  const originValue = process.env.PHP_ORIGIN;
  if (!originValue) {
    response.status(503).json({ error: 'PHP_ORIGIN is not configured for this Vercel deployment.' });
    return;
  }

  let origin;
  try {
    origin = new URL(originValue);
  } catch {
    response.status(503).json({ error: 'PHP_ORIGIN is invalid.' });
    return;
  }
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    response.status(503).json({ error: 'PHP_ORIGIN must be an HTTPS origin without a path or credentials.' });
    return;
  }

  const proxySecret = process.env.PHP_PROXY_SECRET ?? '';
  if (proxySecret.length < 32) {
    response.status(503).json({ error: 'PHP proxy authentication is not configured.' });
    return;
  }

  const incomingPath = request.query?.__path;
  const relativePath = Array.isArray(incomingPath) ? incomingPath[0] : incomingPath;
  if (
    typeof relativePath !== 'string' ||
    relativePath.includes('\\') ||
    /(^|\/)\.\.(\/|$)/.test(relativePath) ||
    /^[a-z][a-z0-9+.-]*:/i.test(relativePath)
  ) {
    response.status(400).json({ error: 'Invalid proxy path.' });
    return;
  }

  const upstreamUrl = new URL(`/${relativePath.replace(/^\/+/, '')}`, origin);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (key === '__path') continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string') upstreamUrl.searchParams.append(key, item);
    }
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined || hopByHopHeaders.has(key.toLowerCase())) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const method = request.method ?? 'GET';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signedMessage = `${timestamp}\n${method.toUpperCase()}\n${upstreamUrl.pathname}`;
  headers.set('x-ethcryptohub-proxy-timestamp', timestamp);
  headers.set(
    'x-ethcryptohub-proxy-signature',
    createHmac('sha256', proxySecret).update(signedMessage).digest('hex'),
  );

  let body;
  if (!['GET', 'HEAD'].includes(method)) {
    try {
      body = await readRequestBody(request, 3 * 1024 * 1024);
    } catch (error) {
      response.status(error instanceof RangeError ? 413 : 400).json({ error: 'Unable to read request body.' });
      return;
    }
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(55_000),
    });
    response.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!hopByHopHeaders.has(key.toLowerCase()) && key.toLowerCase() !== 'set-cookie') {
        response.setHeader(key, value);
      }
    });
    const cookies = upstream.headers.getSetCookie?.() ?? [];
    if (cookies.length > 0) response.setHeader('set-cookie', cookies);
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(response);
    else response.end();
  } catch {
    response.status(502).json({ error: 'The application origin is temporarily unavailable.' });
  }
}

module.exports = proxy;
module.exports.config = config;

import { defineTool } from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-http'
export const inject = ['tools']

const METHOD_ENUM = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
const PICKED_HEADERS = ['content-type', 'content-length', 'location', 'server']

// Fold every failure into the canonical value instead of throwing, so the tool
// body always stays inside its declared output schema.
function requestError(stage, message) {
  return { ok: false, error: { stage, message } }
}

// Perform one HTTP request. Never throws: network errors, timeouts, and
// validation gaps all come back as { ok: false, error: { stage, message } }.
async function performRequest(args) {
  const started = Date.now()

  // 1. URL scheme gate — the only SSRF guard by design (see README: this is a
  //    local personal tool, so no intranet blocking is applied).
  let url
  try {
    url = new URL(args.url)
  } catch {
    return requestError('request', `invalid URL: ${args.url}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return requestError('request', `unsupported scheme "${url.protocol.replace(/:$/, '')}" — only http/https are allowed`)
  }

  // 2. body/json mutual exclusion (cross-field rule the schema cannot express).
  if (args.body !== undefined && args.json !== undefined) {
    return requestError('request', 'body and json are mutually exclusive: provide one of them, not both')
  }

  // 3. Build headers. The auth convenience writes Authorization in memory only.
  const headers = {}
  for (const [key, value] of Object.entries(args.headers || {})) {
    headers[key] = String(value)
  }
  if (args.auth) {
    const auth = args.auth
    if (auth.type === 'bearer') {
      if (typeof auth.token !== 'string' || auth.token === '') {
        return requestError('request', 'auth.type "bearer" requires a non-empty token')
      }
      headers.authorization = `Bearer ${auth.token}`
    } else if (auth.type === 'basic') {
      if (typeof auth.username !== 'string' || typeof auth.password !== 'string') {
        return requestError('request', 'auth.type "basic" requires username and password strings')
      }
      const credentials = Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')
      headers.authorization = `Basic ${credentials}`
    } else {
      return requestError('request', `auth.type must be "bearer" or "basic", got ${JSON.stringify(auth.type)}`)
    }
  }

  // 4. Body: json auto-stringifies and sets application/json when unset.
  let body
  if (args.json !== undefined) {
    body = JSON.stringify(args.json)
    if (headers['content-type'] === undefined) headers['content-type'] = 'application/json'
  } else if (args.body !== undefined) {
    body = args.body
  }

  const method = args.method || 'GET'
  const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 10000
  const maxBodyChars = typeof args.maxBodyChars === 'number' ? args.maxBodyChars : 4000

  // 5. Issue the request. redirect: 'manual' keeps 3xx visible so the caller can
  //    see redirectTo instead of silently following.
  let res
  try {
    res = await fetch(args.url, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const causeMessage = err && err.cause && err.cause.message ? err.cause.message : ''
    const message = err && err.name === 'TimeoutError'
      ? `request timed out after ${timeoutMs}ms`
      : `${(err && err.message) || String(err)}${causeMessage ? ` (${causeMessage})` : ''}`
    return requestError('request', message)
  }

  const durationMs = Date.now() - started
  const status = res.status
  const statusText = res.statusText
  const contentType = res.headers.get('content-type')

  // 6. Read the whole body to learn its true size, then bound the stored text.
  let sizeBytes = 0
  let text = ''
  try {
    const buffer = await res.arrayBuffer()
    sizeBytes = buffer.byteLength
    text = new TextDecoder('utf-8').decode(buffer)
  } catch (err) {
    return requestError('request', `failed to read response body: ${(err && err.message) || err}`)
  }

  const truncated = text.length > maxBodyChars
  const outText = truncated ? text.slice(0, maxBodyChars) : text

  const result = {
    ok: true,
    status,
    statusText,
    durationMs,
    sizeBytes,
    truncated,
  }

  if (contentType) result.contentType = contentType

  const picked = {}
  for (const headerName of PICKED_HEADERS) {
    const headerValue = res.headers.get(headerName)
    if (headerValue !== null) picked[headerName] = headerValue
  }
  if (Object.keys(picked).length > 0) result.headers = picked

  if (status >= 300 && status < 400 && picked.location) result.redirectTo = picked.location

  // 7. Classify JSON vs text. Parse only when the body fits the limit; for an
  //    oversized body, sniff whether it looks like JSON.
  const looksJson = (contentType !== null && /json/i.test(contentType)) || /^\s*[\[{]/.test(text)
  if (truncated) {
    if (looksJson) {
      result.json = null
      result.text = outText
    } else {
      result.text = outText
    }
  } else {
    try {
      result.json = JSON.parse(text)
    } catch {
      result.text = text
    }
  }

  return result
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'http_request',
    description:
      'Perform a structured HTTP request using the Node built-in fetch. ' +
      'Returns a canonical object with ok/status/statusText/durationMs/sizeBytes, ' +
      'plus parsed json or truncated text, and never throws: failures come back ' +
      'as { ok: false, error: { stage, message } }.',
    parameters: {
      url: {
        type: 'string',
        required: true,
        description: 'Target URL. Must use the http or https scheme.',
      },
      method: {
        type: 'string',
        enum: METHOD_ENUM,
        default: 'GET',
        description: 'HTTP method. Defaults to GET.',
      },
      headers: {
        type: 'object',
        additionalProperties: true,
        description: 'Optional extra request headers as key → string.',
      },
      body: {
        type: 'string',
        description: 'Optional raw request body string. Mutually exclusive with json.',
      },
      json: {
        type: 'json',
        description:
          'Optional JSON value (usually an object) to send. Automatically ' +
          'JSON.stringify-ed with content-type application/json. Mutually exclusive with body.',
      },
      timeoutMs: {
        type: 'number',
        default: 10000,
        description: 'Request timeout in milliseconds. Defaults to 10000.',
      },
      maxBodyChars: {
        type: 'number',
        default: 4000,
        description: 'Maximum characters of the response body to return. Defaults to 4000.',
      },
      auth: {
        type: 'object',
        additionalProperties: true,
        description:
          'Optional authentication helper. One of { type: "bearer", token } or ' +
          '{ type: "basic", username, password }. Generates the Authorization header in memory.',
        properties: {
          type: { type: 'string', enum: ['bearer', 'basic'], description: 'Auth scheme.' },
          token: { type: 'string', description: 'Bearer token (required when type is bearer).' },
          username: { type: 'string', description: 'Basic auth username (required when type is basic).' },
          password: { type: 'string', description: 'Basic auth password (required when type is basic).' },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', description: 'Whether a response was received.' },
          status: { type: 'number', description: 'HTTP status code (success only).' },
          statusText: { type: 'string', description: 'HTTP status text (success only).' },
          durationMs: { type: 'number', description: 'Round-trip time in milliseconds (success only).' },
          sizeBytes: { type: 'number', description: 'Response body size in bytes (success only).' },
          contentType: { type: 'string', description: 'Response content-type header, when present.' },
          truncated: { type: 'boolean', description: 'Whether the response body exceeded maxBodyChars.' },
          redirectTo: { type: 'string', description: 'Location header of a 3xx response, when present.' },
          headers: { type: 'object', additionalProperties: true, description: 'Selected response headers (content-type/content-length/location/server), only those present.' },
          json: { type: 'json', description: 'Parsed JSON body on success; null when a JSON body was truncated.' },
          text: { type: 'string', description: 'Truncated text body when the response is not (fully) JSON.' },
          error: {
            type: 'object',
            additionalProperties: true,
            description: 'Failure detail, only present when ok is false.',
            properties: {
              stage: { type: 'string', description: "Failure stage: 'request'." },
              message: { type: 'string', description: 'Human-readable failure reason.' },
            },
          },
        },
      },
      render(args, value) {
        if (!value || value.ok === false) {
          const err = (value && value.error) || {}
          return [{ type: 'text', text: `HTTP ${args.method || 'GET'} ${args.url} 失败 [${err.stage || 'request'}]: ${err.message || 'unknown error'}` }]
        }
        const parts = [`HTTP ${args.method || 'GET'} ${args.url} → ${value.status} ${value.statusText || ''}`]
        parts.push(`${value.durationMs}ms · ${value.sizeBytes}B`)
        if (value.truncated) parts.push('(响应已截断)')
        if (value.redirectTo) parts.push(`→ 跳转: ${value.redirectTo}`)
        return [{ type: 'text', text: parts.join(' ') }]
      },
    },
    async execute(args) {
      return performRequest(args)
    },
  }))

  void selfTest(ctx)
}

// Self-test on mount: drive one success call through the real execution pipeline
// and one error call against a non-resolvable domain, then print evidence lines.
async function selfTest(ctx) {
  const run = (callId, url, timeoutMs) => ctx.tools.execute({
    callId: CallId(callId),
    name: 'http_request',
    arguments: { url, method: 'GET', timeoutMs },
    signal: new AbortController().signal,
  })

  // Success path: httpbin echoes the probe back as JSON.
  try {
    const res = await run('http-self-test-ok', 'https://httpbin.org/anything?probe=1', 15000)
    if (res.isError) {
      console.log('[dsh-http] self-test success-path ERROR:', JSON.stringify(res.error))
    } else {
      const v = res.value
      console.log(`[dsh-http] self-test OK: status=${v.status} durationMs=${v.durationMs} json=${JSON.stringify(v.json)}`)
    }
  } catch (err) {
    console.log('[dsh-http] self-test success-path THREW:', (err && err.message) || err)
  }

  // Error path: a .invalid TLD is guaranteed non-resolvable.
  try {
    const res = await run('http-self-test-err', 'https://nonexistent-domain.invalid/', 5000)
    if (res.isError) {
      console.log('[dsh-http] self-test error-path ERROR:', JSON.stringify(res.error))
    } else {
      const v = res.value
      console.log(`[dsh-http] self-test ERR: ok=${v.ok} stage=${v.error && v.error.stage} message=${v.error && v.error.message}`)
    }
  } catch (err) {
    console.log('[dsh-http] self-test error-path THREW:', (err && err.message) || err)
  }
}

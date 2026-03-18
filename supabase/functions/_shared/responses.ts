
import { corsHeaders, corsHeadersForCache } from './cors.ts';

export function errorResp(message: string, status = 400, body: object = {}) {
    console.error(message);
    return new Response(
        JSON.stringify(body),
        {
            status,
            headers: {
                ...corsHeaders,
                'Content-Type': 'application/json',
                'Connection': 'keep-alive'
            }
        }
    );
}

export function successResp(body: object = {}, status = 200, additionalHeaders: Record<string, string> = {}) {
    return new Response(
        JSON.stringify(body),
        {
            status,
            headers: {
                ...corsHeaders,
                'Content-Type': 'application/json',
                'Connection': 'keep-alive',
                ...additionalHeaders
            }
        }
    );
}

export function successRespWithCache(body: object = {}, maxAge = 300, sMaxAge = 3600, surrogateKey = 'config') {
    return new Response(
        JSON.stringify(body),
        {
            status: 200,
            headers: {
                ...corsHeadersForCache,
                'Content-Type': 'application/json',
                'Cache-Control': `public, max-age=${maxAge}, s-maxage=${sMaxAge}`,
                'Surrogate-Control': `max-age=${sMaxAge}`,
                'Surrogate-Key': surrogateKey
            }
        }
    );
}
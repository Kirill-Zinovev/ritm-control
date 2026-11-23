export function json(value, status=200, extra={}) {
  return Response.json(value,{status,headers:{
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra,
  }});
}

export function isJson(request) {
  return /^application\/json(?:;|$)/i.test(request.headers.get('Content-Type')??'');
}

export function sameOriginJson(request) {
  return request.headers.get('Origin')===new URL(request.url).origin && isJson(request);
}

export async function readJson(request, limit) {
  const bytes=request.body?.getReader();
  if (!bytes) return null;
  const decoder=new TextDecoder();
  let size=0, body='';
  try {
    for (;;) {
      const {done,value}=await bytes.read();
      if (done) return JSON.parse(body+decoder.decode());
      size+=value.byteLength;
      if (size>limit) { await bytes.cancel(); return null; }
      body+=decoder.decode(value,{stream:true});
    }
  } catch { return null; }
}

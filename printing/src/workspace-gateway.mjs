const urlPattern = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;

export function parsePrintingConnections(value) {
  const connections = JSON.parse(value);
  for (const department of ['box','roll']) {
    const item = connections?.[department];
    if (!item || !urlPattern.test(item.url || '') || !/^[a-f0-9]{64}$/.test(item.token || '') ||
        !/^[\w-]{20,100}$/.test(item.sourceId || '')) throw new Error('Подключение журнала не подтверждено.');
  }
  return connections;
}

export async function callPrintingGateway(connection,request,fetcher=fetch) {
  if (!urlPattern.test(connection.url)) throw new Error('Неверный адрес шлюза печати.');
  const signal = AbortSignal.timeout(55000);
  let response = await fetcher(connection.url,{method:'POST',redirect:'manual',signal,
    headers:{'Content-Type':'application/json'},body:JSON.stringify({...request,printingWeb:1,token:connection.token})});
  if ([302,303].includes(response.status)) {
    const location = new URL(response.headers.get('location'));
    if (location.origin !== 'https://script.googleusercontent.com' || location.username || location.password) {
      throw new Error('Шлюз печати не подтвердил доступ.');
    }
    // ContentService redirects the result to Google. The write request and
    // its token stay on the original endpoint.
    response = await fetcher(location.href,{method:'GET',redirect:'manual',signal});
  }
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Шлюз печати не вернул подтверждение ('+response.status+').');
  }
  return response.json();
}

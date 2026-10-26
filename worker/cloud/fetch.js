import {CloudError} from './access.js';
// Workers supports manual/follow only. Preserve redirect:error's security
// semantics explicitly rather than silently allowing automatic redirects.
export async function cloudFetch(fetcher,input,init={}) {
  const rejectRedirect=init.redirect==='error';
  const response=await fetcher(input,rejectRedirect?{...init,redirect:'manual'}:init);
  if(rejectRedirect && [301,302,303,307,308].includes(response.status))throw new CloudError('unexpected_redirect','Сервис вернул неподтверждённое перенаправление. Повторная запись не выполнялась.',503);
  return response;
}

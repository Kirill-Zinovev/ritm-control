import {rowKey} from './workspace-data.mjs';
import {MAX_ROLLS, printEmployee} from './printing-workflow.mjs';

export const rowIdentity = order => ({row:order.row,uid:order.rawUid || order.uid,article:order.article});

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const shortText = (value,max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
export const validSupplyId = value => typeof value === 'string' && /^[\w-]{20,100}:\d{1,16}$/.test(value);
export const BOX_GATEWAY_BATCH = 20;

export function prepareCloudWrite(request) {
  const {department,supplyId,command,items,requestId,operation} = request || {};
  if (!['roll','box'].includes(department) || !validSupplyId(supplyId) ||
      !Array.isArray(items) || items.length < 1 || items.length > 500) return null;
  if (items.some(item => !shortText(item?.rowId,240) || !positive(item.quantity)) ||
      new Set(items.map(item => item.rowId)).size !== items.length) return null;
  const scope = {department,supplyId,command,checking:request.checking === true};
  if (department === 'box') {
    if (command !== 'work' || items.length > BOX_GATEWAY_BATCH ||
      items.some(item => !uuid(item.requestId) || !['take','print','cut'].includes(item.action) ||
        !['pieces','sheets'].includes(item.unit) || !shortText(item.employeeId,100) ||
        typeof item.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(item.fingerprint) || item.quantity > 1000000)) return null;
    return {...scope,items:items.map(({rowId,requestId,action,unit,employeeId,fingerprint,quantity}) =>
      ({rowId,requestId,action,unit,employeeId,fingerprint,quantity}))};
  }
  if (!uuid(requestId)) return null;
  if (command === 'create') {
    if (items.some(item => !shortText(item.name,60) || !printEmployee(item.name) || !positive(item.count) ||
        !positive(item.expectedPlan) || !nonnegative(item.expectedAllocated) || !positive(item.quantity*item.count)) ||
        items.reduce((sum,item) => sum+item.count,0) > MAX_ROLLS) return null;
    return {...scope,requestId,items:items.map(({rowId,name,quantity,count,expectedPlan,expectedAllocated}) =>
      ({rowId,name,quantity,count,expectedPlan,expectedAllocated}))};
  }
  if (command !== 'work' || !['print','cut'].includes(operation) || items.length !== 1) return null;
  const [{rowId,rollId,quantity,expectedQuantity,expectedActual}] = items;
  if (!shortText(rollId,120) || !positive(expectedQuantity) || !nonnegative(expectedActual)) return null;
  return {...scope,requestId,operation,items:[{rowId,rollId,quantity,expectedQuantity,expectedActual}]};
}

export function applyBoxContext(details,group,current) {
  if (current?.ok !== true || !Array.isArray(current.items) || !Array.isArray(current.employees)) {
    throw new Error('Рабочий журнал бокса не подтвердил данные.');
  }
  const positions = new Map(current.items.map(({row,...position}) => [row,position]));
  return {...details,employees:current.employees,
    rows:details.rows.map((row,index) => ({...row,...positions.get(group.orders[index].row)}))};
}

export async function writePrinting(connection, group, request, callPrintingGateway) {
  const orders = new Map(group.orders.map(order => [rowKey(order),order]));
  if (!Array.isArray(request.items) || request.items.length < 1 || request.items.length > 500) {
    return {rejected:true,message:'Выберите от 1 до 500 позиций.'};
  }
  const items = request.items.map(item => {
    const order = orders.get(item.rowId);
    return order && {...item,...rowIdentity(order)};
  });
  if (items.some(item => !item)) return request.checking ? {uncertain:true,message:'Строка изменилась. Проверьте журнал в исходной таблице.'} :
    {rejected:true,message:'Позиция изменилась. Обновите поставку.'};
  const sheetId = group.orders[0].sheetId;
  if (group.department === 'box' && request.command === 'work') {
    const results = [];
    for (let index=0; index<items.length; index+=BOX_GATEWAY_BATCH) {
      const batch = items.slice(index,index+BOX_GATEWAY_BATCH);
      try {
        const reply = await callPrintingGateway(connection,{command:'work',sheetId,items:batch});
        if (!reply.ok || reply.results?.length !== batch.length) throw new Error(reply.message || 'Не получены все отметки.');
        const part = reply.results.map((result,offset) => ({...result,rowId:batch[offset].rowId,article:batch[offset].article}));
        results.push(...part);
        if (part.some(item => !item.ok && !item.notSaved)) return {uncertain:true,results};
      } catch (error) { return {uncertain:true,results,message:error.message}; }
    }
    return {results};
  }
  if (group.department !== 'roll' || !['create','work'].includes(request.command)) return {rejected:true,message:'Команда недоступна.'};
  const result = await callPrintingGateway(connection,{command:request.command,requestId:request.requestId,
    operation:request.operation,sheetId,items});
  if (result.rejected) return {rejected:true,message:result.message};
  if (!result.ok || result.requestId !== request.requestId || !Array.isArray(result.orders)) return {uncertain:true,message:result.message};
  return {message:result.message,confirmed:result.confirmed,skipped:result.skipped,
    patches:result.orders.flatMap(order => {
      const source = group.orders.find(item => item.row === order.row && rowIdentity(item).uid === order.uid);
      if (!source) return [];
      return [{id:rowKey(source),printed:order.print.actual,cut:order.cut.actual,cutEmployeeCode:order.cutEmployeeCode,
        rolls:order.rolls.map(roll => ({id:roll.rollId,name:roll.name,number:roll.number,quantity:roll.quantity,
          printed:roll.printActual,cut:roll.cutActual,printEmployee:roll.employee}))}];
    })};
}

import { Fragment, useState } from 'react';
import { Package, CaretRight } from './icons';
import { inPeriod, num, type Period } from './model';
import type { BoxPrintingEvent, LivePrinting } from './livePrinting';

const goodsNumber = (value: number) => {
  const rounded = Math.round(value * 1000) / 1000;
  return (Math.abs(value - rounded) > 1e-9 ? '≈ ' : '') + new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(value);
};

export function BoxPrintingStats({value,date,period,supplyFilter}:{value:LivePrinting|null;date:string;period:Period;supplyFilter:string}) {
  const [employee,setEmployee]=useState('');
  const [exceptionType,setExceptionType]=useState<'all'|'defect'|'surplus'>('all');
  const [query,setQuery]=useState('');
  const source=value?.boxPrinting;
  const inScope=(e:{date:string;sheetId:number;shipment:string})=>inPeriod(e.date,date,period)&&(supplyFilter==='all'||supplyFilter===`box-printing::${e.sheetId}`||supplyFilter===e.shipment);
  const events=(source?.events||[]).filter(inScope);
  const cutEvents=(source?.cutEvents||[]).filter(inScope);
  const people=[...new Set([...events,...cutEvents].map(e=>e.employee))].sort((a,b)=>a.localeCompare(b,'ru'));
  const totals=(rows:BoxPrintingEvent[])=>({area:rows.reduce((n,e)=>n+(e.area??0),0),missing:rows.filter(e=>e.area===null).length,quantity:rows.reduce((n,e)=>n+e.quantity,0),xeroxQuantity:rows.filter(e=>e.sheets!==null).reduce((n,e)=>n+e.quantity,0),sheets:rows.reduce((n,e)=>n+(e.sheets??0),0)});
  const total=totals(events);
  const totalCut=totals(cutEvents);
  const exceptions=(source?.exceptions||[]).filter(inScope);
  const filteredExceptions=exceptions.filter(e=>(exceptionType==='all'||exceptionType===e.kind)&&[e.article,e.shipment,e.employee,e.comment].some(v=>v.toLocaleLowerCase('ru-RU').includes(query.trim().toLocaleLowerCase('ru-RU')))).sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp));

  return <><section className="panel printing-department printing-department--box" aria-label="Печать бокса">
    <div className="printing-department-heading"><div className="printing-department-title"><span className="printing-department-icon"><Package size={30}/></span><div><h2>Бокс</h2><p>Печать и порезка · отменённые записи исключены</p></div></div>{source?.status==='available'&&<div className="printing-kpis">{[["Площадь печати",num(total.area,2)+" м²"],["Площадь порезки",num(totalCut.area,2)+" м²"]].map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>}</div>
    {source?.status!=='available'?<p role="status">{source?.reason||'Журнал бокса ещё не подключён к этому снимку.'}</p>:<>
      {(total.missing>0||totalCut.missing>0)&&<p className="printing-area-warning">Площадь не подтверждена: печать — {total.missing} записей, порезка — {totalCut.missing}. Показаны подтверждённые значения.</p>}
      <p className="box-stat-explainer">По каждому сотруднику за выбранный период. Нажмите на имя, чтобы увидеть артикулы и комментарии.</p>
      <div className="table-wrap printing-employee-table box-summary-table">
        <table>
          <thead><tr><th scope="col">Сотрудник</th><th scope="col">Печать</th><th scope="col">Порезка</th></tr></thead>
          <tbody>{people.map(name=>{
            const rows=events.filter(e=>e.employee===name),cuts=cutEvents.filter(e=>e.employee===name),t=totals(rows),cut=totals(cuts),open=employee===name;
            const operation=(label:string, records:BoxPrintingEvent[], result:ReturnType<typeof totals>)=>records.length ? <div className="box-operation-summary">
              <strong>{result.missing===records.length?'Площадь не определена':`${num(result.area,2)} м²`}</strong>
              <span>{label}: <b>{goodsNumber(result.quantity)} шт.</b></span>
              {result.sheets>0&&<span>Листов Xerox: <b>{num(result.sheets)} лист.</b></span>}
              {result.missing>0&&result.missing<records.length&&<small>Без площади: {result.missing} записей</small>}
            </div> : <span className="box-no-work">Нет записей</span>;
            return <Fragment key={name}>
              <tr className={open?'selected':''}>
                <th scope="row"><button className="printing-employee-toggle" aria-expanded={open} onClick={()=>setEmployee(open?'':name)}><CaretRight size={18} style={{transform:open?'rotate(90deg)':undefined}}/>{name}</button></th>
                <td>{operation('Напечатано',rows,t)}</td><td>{operation('Порезано',cuts,cut)}</td>
              </tr>
              {open&&<tr><td colSpan={3}><div className="printing-work-detail"><h3>Работа сотрудника: {name}</h3>
                {rows.length>0&&<div className="table-wrap"><table><thead><tr><th>Дата</th><th>Поставка</th><th>Артикул</th><th>Напечатано, шт.</th><th>Листы Xerox</th><th>м²</th><th>Комментарий</th></tr></thead><tbody>{rows.map(e=><tr key={e.id}><td>{e.date}</td><td>{e.shipment}</td><td>{e.article}</td><td>{goodsNumber(e.quantity)}</td><td>{e.sheets===null?'—':num(e.sheets)}</td><td>{e.area===null?'Не определена':num(e.area,2)}</td><td className="box-exception-comment">{e.comment?.trim()||'—'}</td></tr>)}</tbody></table></div>}
                {cuts.length>0&&<div className="printing-cut-detail"><h3>Порезка</h3><div className="table-wrap"><table><thead><tr><th>Дата</th><th>Поставка</th><th>Артикул</th><th>Порезано, шт.</th><th>Листы Xerox</th><th>Комментарий</th></tr></thead><tbody>{cuts.map(e=><tr key={e.id}><td>{e.date}</td><td>{e.shipment}</td><td>{e.article}</td><td>{goodsNumber(e.quantity)}</td><td>{e.sheets===null?'—':num(e.sheets)}</td><td className="box-exception-comment">{e.comment?.trim()||'—'}</td></tr>)}</tbody></table></div></div>}
              </div></td></tr>}
            </Fragment>;
          })}</tbody>
        </table>
      </div>
      {[...events,...cutEvents].some(e=>!Number.isInteger(e.quantity))&&<p className="box-stat-footnote">Дробные штуки появляются при пересчёте листов Xerox в количество товаров.</p>}
      {!events.length&&!cutEvents.length&&<p>Нет подтверждённых записей печати или порезки бокса за выбранный период.</p>}

    </>}
  </section>
  <section className="panel box-exceptions" aria-label="Брак и излишки по артикулам">
    <div className="box-exceptions-heading"><h2>Брак и излишки по артикулам</h2><p>Записи сотрудников · отменённые записи исключены</p></div>
    {source?.status!=='available'?<p role="status">{source?.reason||'Журнал бокса ещё не подключён.'}</p>:source.exceptions===undefined?<p role="status">Данные о браке и излишках пока недоступны. Обновите источник данных.</p>:<>
      <div className="box-exceptions-controls"><div className="box-exceptions-filters" aria-label="Тип записи">{([['all','Все'],['defect','Брак'],['surplus','Излишки']] as const).map(([id,label])=><button key={id} type="button" aria-pressed={exceptionType===id} onClick={()=>setExceptionType(id)}>{label} ({id==='all'?exceptions.length:exceptions.filter(e=>e.kind===id).length})</button>)}</div><label className="box-exceptions-search"><span className="sr-only">Поиск по журналу</span><input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Поиск по артикулу, поставке или сотруднику" /></label></div>
      {filteredExceptions.length?<div className="table-wrap box-exceptions-table"><table><thead><tr><th>Дата и время</th><th>Артикул</th><th>Поставка</th><th>Сотрудник</th><th>Тип</th><th>Количество</th><th>Комментарий</th></tr></thead><tbody>{filteredExceptions.map(e=><tr key={e.id}><td>{new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(e.timestamp))}</td><td><strong>{e.article||'—'}</strong></td><td>{e.shipment||'—'}</td><td>{e.employee||'—'}</td><td><span className={'box-exception-badge is-'+e.kind}>{e.kind==='defect'?'Брак':'Излишек'}</span>{e.stage&&<small className="box-exception-stage">{e.stage}</small>}</td><td>{num(e.quantity)} {e.unit==='sheets'?'лист.':e.unit==='pieces'?'шт.':'(ед. не указана)'}</td><td className="box-exception-comment">{e.comment||'—'}</td></tr>)}</tbody></table></div>:<p className="box-exceptions-empty">{exceptions.length?'По выбранному фильтру записей нет.':'За выбранный период записей о браке и излишках нет.'}</p>}
    </>}
  </section></>;
}

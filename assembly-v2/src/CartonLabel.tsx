import { useState } from 'react';
import { Printer } from 'lucide-react';
import type { Carton } from '../shared/model';
import { number } from '../shared/model';
import { warehouseCity } from '../shared/warehouse-filter';
import { Button, Dialog } from './ui';

/** Internal carton identification; marketplace shipping labels remain separate. */
export function CartonLabel({box,onClose}:{box:Carton;onClose():void}) {
  const [error,setError]=useState('');
  const destination=`${box.market} · ${warehouseCity(box).label} · Магазин ${box.store || 'не определён'}`;
  function print() {
    setError('');
    const popup=window.open('','_blank');
    if(!popup){setError('Разрешите всплывающее окно для печати.');return;}
    popup.opener=null;
    const doc=popup.document;
    doc.open();doc.write('<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Номер короба — RITM Сборка</title></head><body></body></html>');doc.close();
    const style=doc.createElement('style');
    style.textContent='@page{size:auto;margin:3mm}body{margin:0;color:#000;font-family:Arial,sans-serif;text-align:center}main{padding:2mm;overflow-wrap:anywhere}h1{font-size:38pt;line-height:1.1;margin:4mm 0}p{font-size:11pt;margin:2mm 0}small{font-size:8pt}';
    doc.head.append(style);
    const content=doc.createElement('main');
    for(const [tag,text] of [['small','RITM Сборка'],['h1',box.label],['p',destination],['p',`${number(box.qty)} шт. · ${box.items.length} вложений`]]) {
      const element=doc.createElement(tag);element.textContent=text;content.append(element);
    }
    doc.body.append(content);popup.focus();popup.print();
  }
  return <Dialog title="Этикетка короба" onClose={onClose}>
    <div className="carton-label-preview"><small>RITM Сборка</small><strong>{box.label}</strong><p>{destination}</p><p>{number(box.qty)} шт. · {box.items.length} вложений</p></div>
    <p className="muted">Внутренняя маркировка короба. Для маркетплейса используйте его отгрузочную этикетку. Размер бумаги выберите в настройках печати.</p>
    {error && <p role="alert" className="field-error">{error}</p>}
    <div className="actions"><Button onClick={onClose}>Закрыть</Button><Button primary onClick={print}><Printer size={17}/>Печатать</Button></div>
  </Dialog>;
}

import { useState } from 'react';
import type { Page } from './model';
import { Truck, Package, ChartBar, Bot, Plus, CaretRight, CheckCircle, MagnifyingGlass } from './icons';
import './HelpWorkspace.css';

type Lesson = { title:string; description:string; page:Page; steps:string[]; owner?:boolean };
const lessons:Lesson[] = [
  {title:'Создать поставку',description:'Название, состав и распределение по участкам.',page:'supplies',steps:['Откройте «Поставки» и нажмите «Новая поставка».','Введите название поставки в поле «Название поставки».','Вставьте артикулы с количеством или нажмите «Загрузить Excel».','Нажмите «Проверить распределение».','Проверьте участки и нажмите «Подтвердить и создать поставку».']},
  {title:'Добавить товары в поставку',description:'Дополните состав существующей поставки.',page:'supplies',steps:['Откройте «Поставки» и выберите нужную поставку в списке слева.','Нажмите «Добавить товары» в карточке поставки.','Введите артикулы с количеством или загрузите Excel и нажмите «Проверить распределение».','Проверьте участки и нажмите «Подтвердить и добавить товары».']},
  {title:'Задание для запасов',description:'Направьте товары на склад или срочный второй этаж.',page:'reserves',steps:['Откройте «Запасы» и в поле «Назначение» выберите, куда направить товары.','Введите артикулы и количество или загрузите Excel.','Нажмите «Проверить и распределить».','Проверьте список и нажмите «Добавить в запасы».']},
  {title:'Готовность поставок',description:'Посмотрите печать, порезку и сборку.',page:'supplies',steps:['Откройте «Поставки» и выберите поставку.','Посмотрите блок готовности участков.','Прокрутите вниз до таблицы товаров и изучите отдельные позиции.']},
  {title:'Выработка сотрудников',description:'Печать и порезка за выбранный период.',page:'printing',steps:['Откройте «Печать» и выберите период.','Выберите рулонную печать или бокс.','Нажмите на сотрудника, чтобы увидеть подробности.']},
  {title:'Настройки Аркадия',description:'Управление уведомлениями для владельца.',page:'arkady',owner:true,steps:['Откройте раздел «Аркадий».','Проверьте состояние подключения и настройки уведомлений.','Измените доступные настройки при необходимости.']},
];
export function FirstVisitWelcome({identity,onOpen}:{identity:string;onOpen:()=>void}) {
  const key = `ritm-welcome-v1:${identity}`;
  const [open,setOpen]=useState(()=>{try{return localStorage.getItem(key)!=='done'}catch{return false}});
  const close=()=>{try{localStorage.setItem(key,'done')}catch{}setOpen(false)};
  if(!open)return null;
  return <div className="help-overlay welcome-overlay"><div className="welcome-dialog" role="dialog" aria-modal="true" aria-labelledby="welcome-title" aria-describedby="welcome-description"><div className="welcome-content"><div className="welcome-brand">RITM<span>/</span></div><h2 id="welcome-title">Добро пожаловать<br/>в RITM</h2><p id="welcome-description">Всё, что нужно для работы с поставками и производством, собрано в одном месте.</p><div className="welcome-features"><div><Truck size={19}/><span>Создавайте поставки и задания</span></div><div><ChartBar size={19}/><span>Следите за готовностью участков</span></div><div><CheckCircle size={19}/><span>Находите ответы в инструкциях</span></div></div><div className="welcome-actions"><button type="button" className="help-primary" onClick={()=>{close();onOpen()}}>Открыть инструкции <CaretRight size={17}/></button><button type="button" className="help-skip" onClick={close}>Позже</button></div><small className="welcome-hint">К инструкциям можно вернуться в любое время.</small></div><div className="welcome-visual" aria-hidden="true"><img src="/images/welcome-ritm.png" alt=""/></div></div></div>;
}
export default function HelpWorkspace({isOwner,go}:{isOwner:boolean;go:(page:Page)=>void}) {
  const [selected,setSelected]=useState<Lesson|null>(null);
  const [step,setStep]=useState(0);
  const [query,setQuery]=useState('');
  const [filter,setFilter]=useState('Все');
  const openLesson=(lesson:Lesson)=>{setStep(0);setSelected(lesson)};
  const annotated:Record<string,Array<{src:string;x:string;y:string}|null>>={
    'Создать поставку':[{src:'/help/supplies.png',x:'95%',y:'21%'},{src:'/help/create.png',x:'53%',y:'29%'},{src:'/help/create.png',x:'54%',y:'58%'},{src:'/help/create.png',x:'77%',y:'95%'},null],
    'Добавить товары в поставку':[{src:'/help/supplies.png',x:'11%',y:'43%'},{src:'/help/supplies.png',x:'94%',y:'39%'},null,null],
    'Задание для запасов':[{src:'/help/reserves.png',x:'45%',y:'46%'},{src:'/help/reserves.png',x:'43%',y:'58%'},{src:'/help/reserves.png',x:'72%',y:'90%'},null],
    'Готовность поставок':[{src:'/help/supplies.png',x:'11%',y:'43%'},{src:'/help/supplies.png',x:'30%',y:'96%'},null],
    'Выработка сотрудников':[null,{src:'/help/printing.png',x:'31%',y:'13%'},{src:'/help/printing.png',x:'16%',y:'48%'}],
  };
  const stepTargets:Record<string,string[]>={
    'Создать поставку':['Новая поставка','Название поставки','Артикулы и количество','Проверить распределение','Подтвердить и создать поставку'],
    'Добавить товары в поставку':['Вкладки поставок','Добавить товары','Проверить распределение','Подтвердить и добавить товары'],
    'Задание для запасов':['Назначение','Артикулы и количество','Проверить и распределить','Добавить в запасы'],
    'Готовность поставок':['Вкладки поставок','Готовность участков','Таблица товаров'],
    'Выработка сотрудников':['День / Неделя / Месяц','Бокс','Имя сотрудника'],
    'Настройки Аркадия':['Аркадий','Подключение к Битрикс24','Автоматические уведомления'],
  };
  const currentPointer=selected?annotated[selected.title]?.[step]:null;
  const currentPicture=currentPointer || undefined;
  const icons=[Truck,Plus,Package,CheckCircle,ChartBar,Bot];
  const visible=lessons.filter(lesson=>!lesson.owner||isOwner).filter(lesson=>{
    const index=lessons.indexOf(lesson);
    const category=filter==='Все'||(filter==='Поставки'&&lesson.page==='supplies')||(filter==='Запасы'&&lesson.page==='reserves')||(filter==='Печать'&&lesson.page==='printing')||(filter==='Для руководителя'&&index>=3);
    const needle=query.trim().toLocaleLowerCase('ru');
    return category&&(!needle||[lesson.title,lesson.description,...lesson.steps].join(' ').toLocaleLowerCase('ru').includes(needle));
  });
  const card=(lesson:Lesson)=> {const Icon=icons[lessons.indexOf(lesson)];return <button type="button" className="help-task-row" key={lesson.title} onClick={()=>openLesson(lesson)}><span className="help-task-icon" aria-hidden="true"><Icon size={21}/></span><span className="help-task-copy"><strong>{lesson.title}</strong><span>{lesson.description}</span></span><CaretRight className="help-task-arrow" size={19}/></button>};
  return <div className="help-workspace help-directory"><div className="help-search-wrap"><MagnifyingGlass size={20} aria-hidden="true"/><input aria-label="Поиск инструкций" placeholder="Что вы хотите сделать?" value={query} onChange={event=>setQuery(event.target.value)}/></div><div className="help-filters" aria-label="Темы инструкций">{['Все','Поставки','Запасы','Печать','Для руководителя'].map(item=><button type="button" key={item} aria-pressed={filter===item} className={filter===item?'is-active':''} onClick={()=>setFilter(item)}>{item}</button>)}</div>{!query.trim()&&filter==='Все'&&<section className="help-quick"><div><h2>Частые задачи</h2><div className="help-task-list">{[lessons[0],lessons[1],lessons[2],lessons[4]].map(card)}</div></div><aside className="help-feature"><div><h2>Начните с основ</h2><p>Пошаговая инструкция поможет создать первую поставку и проверить распределение товаров.</p><button type="button" onClick={()=>openLesson(lessons[0])}>Открыть инструкцию <CaretRight size={16}/></button></div></aside></section>}<section className="help-all"><h2>{query.trim()||filter!=='Все'?'Результаты':'Все инструкции'}</h2>{visible.length===0?<div className="help-empty" role="status">Ничего не найдено. Попробуйте изменить запрос или выбрать другую тему.</div>:<div className="help-directory-grid">{[false,true].map(leader=>{const group=visible.filter(lesson=>(lessons.indexOf(lesson)>=3)===leader);return group.length>0?<div className="help-directory-group" key={String(leader)}><h3>{leader?'Руководителю':'Менеджеру'}</h3><div className="help-task-list">{group.map(card)}</div></div>:null})}</div>}</section>{selected&&<div className="help-overlay" onClick={()=>setSelected(null)}><div className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={event=>event.stopPropagation()}><button className="help-close" type="button" aria-label="Закрыть" onClick={()=>setSelected(null)}>×</button><span className="help-kicker">ИНСТРУКЦИЯ</span><h2 id="help-title">{selected.title}</h2><p>{selected.description}</p><div className="help-step"><strong>Шаг {step+1} из {selected.steps.length}</strong><p>{selected.steps[step]}</p></div>{!currentPicture&&<div className="help-target-diagram"><span>Раздел: {selected.page === "arkady" ? "Аркадий" : selected.page === "printing" ? "Печать" : selected.page === "reserves" ? "Запасы" : "Поставки"}</span><div><CaretRight size={23} aria-hidden="true"/><strong>{stepTargets[selected.title][step]}</strong></div><small>Схема элемента интерфейса</small></div>}{currentPicture&&<figure className="help-example"><div className="help-example-image"><img src={currentPicture.src} alt={`Пример экрана: ${selected.title}`}/>{currentPointer&&<span className="help-marker" style={{left:currentPicture.x,top:currentPicture.y}} aria-hidden="true">↓</span>}</div><figcaption>Пример интерфейса RITM. Внешний вид может отличаться.</figcaption></figure>}<div className="help-step-actions"><button type="button" className="help-skip" disabled={step===0} onClick={()=>setStep(step-1)}>Назад</button>{step<selected.steps.length-1?<button type="button" className="help-primary" onClick={()=>setStep(step+1)}>Следующий шаг →</button>:<button type="button" className="help-primary" onClick={()=>{go(selected.page);setSelected(null)}}>Открыть раздел →</button>}</div></div></div>}</div>;
}

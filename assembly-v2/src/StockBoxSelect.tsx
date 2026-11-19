import { useEffect, useState } from "react";
import type { WarehouseCarton } from "../shared/warehouse";
import { request } from "./useWorkspace";
import { NativeSelect } from "./ui";
export function StockBoxSelect({market, store, value, onChange, disabled, revision, exclude}: {market:string;store:string;value:string;onChange:(id:string)=>void;disabled?:boolean;revision?:number;exclude?:string}) {
  const [boxes,setBoxes]=useState<WarehouseCarton[]>([]),[error,setError]=useState("");
  useEffect(()=>{const abort=new AbortController();setBoxes([]);setError("");
    request<{cartons:WarehouseCarton[]}>(`/api/warehouse?choices=1&market=${encodeURIComponent(market)}&store=${encodeURIComponent(store)}`,{signal:abort.signal}).then(r=>setBoxes(r.cartons)).catch(e=>{if(!abort.signal.aborted)setError(e.message);});
    return()=>abort.abort();
  },[market,store,revision]);
  return <div><NativeSelect label="В какой складской короб" value={value} disabled={disabled} onChange={e=>onChange(e.target.value)}>
    <option value="">Выберите короб</option>{!exclude?<option value="new">+ Создать новый короб</option>:null}
    {boxes.filter(b=>b.id!==exclude).map(b=><option value={b.id} key={b.id}>{b.label} · {b.qty} шт.</option>)}
  </NativeSelect>{error?<p role="alert" className="form-error">{error}</p>:null}</div>;
}

import { useId, type ReactNode } from 'react';
import { X } from 'lucide-react';

/** Non-modal detail surface: the list stays usable alongside the editor. */
export function ManagerPanel({title,kicker,children,className='',busy=false,onClose}:{title:string;kicker?:string;children:ReactNode;className?:string;busy?:boolean;onClose():void}) {
  const id=useId();
  return <section className={`manager-detail ${className}`} aria-labelledby={id}>
    <header className="manager-detail-header"><div>{kicker && <p className="muted">{kicker}</p>}<h2 id={id}>{title}</h2></div><button type="button" className="icon-button" aria-label="Закрыть карточку" disabled={busy} onClick={onClose}><X size={20}/></button></header>
    <div className="manager-detail-body">{children}</div>
  </section>;
}

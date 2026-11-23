import { useId, useState, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { Field } from './ui';

type Props = {
  label: string;
  value: string;
  options: string[];
  disabled?: boolean;
  inputTag?: string;
  onChange(value: string): void;
};

export function CatalogChoiceField({ label, value, options, disabled, inputTag, onChange }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(-1);
  const visible = [...new Set(options)].filter(option =>
    option.toLocaleLowerCase('ru-RU').includes(filter.trim().toLocaleLowerCase('ru-RU')),
  ).slice(0, 30);
  const choose = (option: string) => {
    onChange(option);
    setOpen(false);
  };
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) setFilter('');
      setOpen(true);
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActive(index => Math.min(visible.length - 1, Math.max(0, index + direction)));
    } else if (event.key === 'Enter' && open && visible[active]) {
      event.preventDefault();
      choose(visible[active]);
    }
  }
  return <div className="catalog-choice">
    <Field id={id} label={label} value={value} disabled={disabled} autoComplete="off" data-label-input={inputTag}
      role="combobox" aria-expanded={open} aria-controls={id+'-list'} aria-autocomplete="list"
      aria-activedescendant={open && visible[active] ? id+'-option-'+active : undefined}
      onFocus={() => {setFilter('');setActive(-1);setOpen(true);}}
      onClick={() => {if(!open){setFilter('');setActive(-1);setOpen(true);}}}
      onBlur={() => setOpen(false)} onKeyDown={keyDown}
      onChange={event => {onChange(event.target.value);setFilter(event.target.value);setActive(-1);setOpen(true);}}/>
    <ChevronDown className="catalog-choice-chevron" size={15} aria-hidden="true"/>
    {open && <div id={id+'-list'} role="listbox" aria-label={label} className="catalog-choice-list">
      {visible.map((option, index) => <div key={option} id={id+'-option-'+index} role="option"
        aria-selected={index===active} className={index===active?'active':undefined}
        onMouseDown={event => event.preventDefault()} onClick={() => choose(option)}>{option}</div>)}
      {!visible.length && <div className="catalog-choice-empty">Можно ввести значение вручную</div>}
    </div>}
  </div>;
}

import React from 'react';
import './printing-chrome.css';

export function PrintingHeader({title, className = '', children}) {
  return <header className={`header printing-header ${className}`.trim()}>
    <div className="brand"><b>RITM /</b> Печать</div>
    <span className="department-title">{title}</span>
    <span className="printing-header-art" aria-hidden="true"/>
    <div className="header-actions">{children}</div>
  </header>;
}

export function SearchField({label, className = '', placeholder = label, ...inputProps}) {
  return <label className={`printing-search ${className}`.trim()}>
    <span className="sr-only">{label}</span>
    <input {...inputProps} className="printing-search-input" type="search" placeholder={placeholder}/>
  </label>;
}

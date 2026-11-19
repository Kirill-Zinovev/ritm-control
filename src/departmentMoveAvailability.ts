export function departmentMoveAvailability({shipmentId,disabled,disabledReason,printed,cut}:{shipmentId:string;disabled:boolean;disabledReason?:string;printed?:number|null;cut?:number|null}) {
  if ((printed ?? 0) > 0 || (cut ?? 0) > 0) return {label:'Работа начата',reason:'Уже отмечены печать или порезка. Перенос разрешён только до начала работы на исходном участке.'};
  if (!shipmentId) return {label:'Нет связи участков',reason:'Эта поставка не подключена к реестру производственных поставок. Для безопасного переноса нужно сначала проверить связь её участков.'};
  if (disabled) return {label:'Временно недоступно',reason:disabledReason || 'Дождитесь проверки доступа и свежих данных поставки.'};
  return null;
}

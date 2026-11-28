export const printingDepartments = {roll:'Рулонная печать', box:'Бокс', cutter:'Резчик'};
export const isPrintingDepartment = value => typeof value === 'string' && Object.hasOwn(printingDepartments,value);
export const printingPinLength = 4;
export const printingPinDigits = `[0-9]{${printingPinLength}}`;

export const money = value => new Intl.NumberFormat('es-PE', {style:'currency', currency:'PEN'}).format(value / 100);
export const cents = value => Math.round(Number(value) * 100);
export const today = () => new Intl.DateTimeFormat('sv-SE', {timeZone:'America/Lima'}).format(new Date());
export const dateFormat = value => value.split('-').reverse().join('/');
export const sum = (items, value) => items.reduce((total, item) => total + value(item), 0);
export const remaining = loan => loan.amount * loan.count - sum(loan.payments, payment => payment.amount);
export const totalPaid = loan => sum(loan.payments, payment => payment.amount);
export const opening = data => (data.initialReceivable ?? 0) - sum(data.loans.filter(loan => loan.type === 'old'), loan => loan.principal);
export const cash = data => (data.initialCash ?? 0)
  - sum(data.loans.filter(loan => loan.type === 'new'), loan => loan.principal)
  + sum(data.loans, loan => totalPaid(loan))
  + sum(data.cashMovements ?? [], movement => movement.type === 'income' ? movement.amount : -movement.amount);

export function due(first, frequency, index) {
  const date = new Date(first + 'T12:00:00Z');
  if (frequency === 'week') date.setUTCDate(date.getUTCDate() + index * 7);
  else if (frequency === 'fortnight') date.setUTCDate(date.getUTCDate() + index * 15);
  else {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + index);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, last));
  }
  return date.toISOString().slice(0, 10);
}

export const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export const validRate = rate => Number.isSafeInteger(rate) && rate >= 0;

export function installmentWithInterest(principal, frequency, count, rate) {
  const unitsPerMonth = {week:1, fortnight:2, month:4};
  const units = BigInt(count * unitsPerMonth[frequency]);
  const numerator = BigInt(principal) * (40000n + units * BigInt(rate));
  const denominator = 40000n * BigInt(count);
  return Number((numerator + denominator - 1n) / denominator);
}

export function withFriends(snapshot) {
  const friends = new Map((snapshot.friends ?? []).map(friend => [friend.person, friend]));
  for (const loan of snapshot.loans) {
    if (!friends.has(loan.person)) friends.set(loan.person, {person:loan.person, dni:'', phone:'', address:''});
  }
  return {...snapshot, friends:[...friends.values()]};
}

export function valid(snapshot) {
  const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 10000000000;
  if (!Array.isArray(snapshot?.loans)) return false;
  for (const field of ['initialCash', 'initialReceivable']) {
    if (snapshot[field] !== undefined && (!Number.isSafeInteger(snapshot[field]) || snapshot[field] < 0 || snapshot[field] > 10000000000)) return false;
  }
  if (snapshot.monthlyRate != null && !validRate(snapshot.monthlyRate)) return false;
  if (snapshot.cashMovements !== undefined && (!Array.isArray(snapshot.cashMovements)
    || !snapshot.cashMovements.every(m => m && typeof m.id === 'string' && m.id
      && ['income', 'expense'].includes(m.type) && positive(m.amount) && validDate(m.date)
      && (m.description === undefined || (typeof m.description === 'string' && m.description.length <= 200)))
    || new Set(snapshot.cashMovements.map(m => m.id)).size !== snapshot.cashMovements.length)) return false;
  if (snapshot.friends !== undefined && (!Array.isArray(snapshot.friends)
    || !snapshot.friends.every(f => f && typeof f.person === 'string' && f.person.trim()
      && typeof f.dni === 'string' && /^(?:\d{8})?$/.test(f.dni)
      && typeof f.phone === 'string' && typeof f.address === 'string'
      && (f.whatsappConsent === undefined || typeof f.whatsappConsent === 'boolean'))
    || new Set(snapshot.friends.map(f => f.person)).size !== snapshot.friends.length)) return false;
  return snapshot.loans.every(l => l && typeof l.id === 'string' && l.id && typeof l.person === 'string'
    && l.person.trim() && ['old', 'new'].includes(l.type) && ['week', 'fortnight', 'month'].includes(l.frequency)
    && (l.monthlyRate === undefined || (l.type === 'new' && validRate(l.monthlyRate)))
    && (l.originalPrincipal === undefined || (l.type === 'old' && positive(l.originalPrincipal)))
    && positive(l.principal) && positive(l.amount) && Number.isInteger(l.count) && l.count >= 1 && l.count <= 120
    && (l.issued === undefined || (validDate(l.issued) && l.issued <= l.first))
    && validDate(l.first) && l.first >= '1900-01-01' && l.first <= '2200-12-31'
    && Array.isArray(l.payments) && l.payments.every(p => p && positive(p.amount) && validDate(p.date)
      && (p.createdAt === undefined || (Number.isSafeInteger(p.createdAt) && p.createdAt > 0)))
    && remaining(l) >= 0 && (l.type === 'old' ? l.principal === l.amount * l.count : l.principal <= l.amount * l.count))
    && new Set(snapshot.loans.map(l => l.id)).size === snapshot.loans.length
    && cash(snapshot) >= 0 && opening(snapshot) >= 0;
}

export function installmentsOf(data) {
  const rows = [];
  data.loans.forEach((loan, index) => {
    let paid = totalPaid(loan);
    for (let n = 0; n < loan.count; n++) {
      const left = Math.max(loan.amount - paid, 0);
      paid = Math.max(paid - loan.amount, 0);
      rows.push({loan, reference:`N.º ${index + 1}`, date:due(loan.first, loan.frequency, n), left, amount:loan.amount, index:n});
    }
  });
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export function paymentsOf(data) {
  const rows = [];
  data.loans.forEach((loan, index) => {
    let balance = loan.amount * loan.count;
    for (const payment of [...loan.payments].sort((a,b) => a.date.localeCompare(b.date))) {
      balance -= payment.amount;
      rows.push({loan, payment, reference:`N.º ${index + 1}`, balance, order:rows.length});
    }
  });
  return rows.sort((a,b) => (b.payment.createdAt ?? 0) - (a.payment.createdAt ?? 0)
    || b.payment.date.localeCompare(a.payment.date) || b.order - a.order);
}

export function whatsappNumber(phone) {
  const number = phone.replace(/\D/g, '');
  if (/^9\d{8}$/.test(number)) return '51' + number;
  if (/^519\d{8}$/.test(number)) return number;
  return '';
}

export function download(name, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], {type}));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const reportHeaders=['N.º','Cliente','Tipo','Frecuencia','Fecha de desembolso','Primera cuota','Número de cuotas','Monto prestado original (S/)','Capital o saldo inicial (S/)','Cuota (S/)','Total pactado (S/)','Abonos recibidos (S/)','Saldo pendiente (S/)','Cuotas vencidas (S/)','Estado'];
function reportMoney(value){return (value/100).toFixed(2);}
export function reportRows(loans,current){
  return loans.map((loan,index)=>{
    let paid=sum(loan.payments,p=>p.amount),overdue=0;
    for(let i=0;i<loan.count;i++){
      const unpaid=Math.max(loan.amount-paid,0);
      paid=Math.max(paid-loan.amount,0);
      if(due(loan.first,loan.frequency,i)<current) overdue+=unpaid;
    }
    const balance=remaining(loan);
    return [index+1,loan.person,loan.type==='old'?'Saldo anterior':'Nuevo desembolso',
      {week:'Semanal',fortnight:'Quincenal',month:'Mensual'}[loan.frequency],
      loan.issued||'',loan.first,loan.count,loan.originalPrincipal?reportMoney(loan.originalPrincipal):'',
      reportMoney(loan.principal),reportMoney(loan.amount),reportMoney(loan.amount*loan.count),
      reportMoney(sum(loan.payments,p=>p.amount)),reportMoney(balance),reportMoney(overdue),
      balance===0?'Pagado':overdue>0?'Vencido':'Pendiente'];
  });
}
export function reportCsv(rows){
  const numericColumns=new Set([0,6,7,8,9,10,11,12,13]);
  const escape=value=>{
    let cell=String(value);
    if(/^[\s]*[=+@-]/.test(cell)) cell="'"+cell;
    return '"'+cell.replace(/"/g,'""')+'"';
  };
  const lines=[reportHeaders.map(escape).join(';'),...rows.map(row=>
    row.map((value,index)=>numericColumns.has(index)?String(value):escape(value)).join(';'))];
  return '\uFEFFsep=;\r\n'+lines.join('\r\n');
}

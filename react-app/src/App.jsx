import {useEffect, useMemo, useRef, useState} from 'react';
import {cash, cents, dateFormat, download, due, installmentWithInterest, installmentsOf, money, opening, paymentsOf, remaining, reportCsv, reportRows, sum, today, totalPaid, valid, validDate, validRate, whatsappNumber, withFriends} from './model.js';

const empty = {loans:[], friends:[]};
const key = 'mis-prestamos-v1';
const routes = [['panel','Panel principal'],['clientes','Clientes'],['nuevo','Préstamos'],['calendario','Calendario'],['pagos','Pagos'],['morosidad','Morosidad'],['reportes','Reportes'],['respaldo','Respaldo']];
const frequencyNames = {week:'Semanal',fortnight:'Quincenal',month:'Mensual'};
const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('es');
const firstDue = (issued,frequency) => validDate(issued) ? due(issued,frequency,1) : '';
const datePlusDays = (value,days) => { const date=new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate()+days); return date.toISOString().slice(0,10); };
const loanLabel = (loan,index) => `${loan.person} · N.º ${index+1} · ${frequencyNames[loan.frequency]} · ${dateFormat(loan.first)} · ${money(remaining(loan))} pendiente`;
const initialLoan = () => ({person:'',type:'new',principal:'',issued:today(),frequency:'week',count:'4',amount:'',first:firstDue(today(),'week')});
const initialPayment = () => ({loanId:'',amount:'',date:today()});

function initialData() {
  const server = window.__PRESTAMOS_BOOTSTRAP__;
  if (server) return valid(server.data) ? withFriends(server.data) : null;
  try {
    const raw = localStorage.getItem(key);
    const data = raw ? JSON.parse(raw) : empty;
    return valid(data) ? withFriends(data) : null;
  } catch { return null; }
}

function Table({headers, rows, emptyText}) {
  if (!rows.length) return <p className="muted">{emptyText}</p>;
  return <div className="scroll-table"><table><thead><tr>{headers.map(header => <th key={header}>{header}</th>)}</tr></thead>
    <tbody>{rows.map((row,index) => <tr key={index}>{row.map((cell,n) => <td key={n} data-label={headers[n]}>{cell}</td>)}</tr>)}</tbody></table></div>;
}

function Metric({label,value,detail,accent=false}) {
  return <section className={accent?'accent-card':''}><span>{label}</span><div className="metric">{value}</div>{detail&&<small>{detail}</small>}</section>;
}

function WhatsAppButton({item,data}) {
  const contact = data.friends.find(friend => friend.person === item.loan.person);
  const number = whatsappNumber(contact?.phone ?? '');
  const status = !item.left ? 'figura pagada' : item.date < today() ? `venció el ${dateFormat(item.date)}` : item.date === today() ? `vence hoy ${dateFormat(item.date)}` : `vence el ${dateFormat(item.date)}`;
  const message = `Hola ${item.loan.person}, la cuota del préstamo ${item.reference} ${status}. ${item.left ? `Saldo pendiente: ${money(item.left)}. ` : ''}Gracias.`;
  return <button type="button" className="wa-button" title={number?'Abrir mensaje en WhatsApp':'Agrega el teléfono del cliente'} aria-label={`WhatsApp para ${item.loan.person}`} disabled={!number}
    onClick={() => window.open(`https://wa.me/${number}?text=${encodeURIComponent(message)}`,'_blank','noopener,noreferrer')} />;
}

export default function App() {
  const server = window.__PRESTAMOS_BOOTSTRAP__;
  const [data,setData] = useState(initialData);
  const [route,setRoute] = useState(() => location.hash.slice(1) || 'panel');
  const [isMobile,setIsMobile] = useState(() => window.matchMedia('(max-width: 900px)').matches);
  const [menuOpen,setMenuOpen] = useState(() => !window.matchMedia('(max-width: 900px)').matches);
  const [notice,setNotice] = useState(data ? '' : 'Restaura una copia válida antes de registrar movimientos.');
  const noticeTimer = useRef();
  const revision = useRef(server?.revision ?? 0);
  const stored = useRef(server ? null : localStorage.getItem(key));
  const busy = useRef(false);
  const [saving,setSaving] = useState(false);
  const [cashAmount,setCashAmount] = useState('');
  const [cashDescription,setCashDescription] = useState('');
  const [cashHistory,setCashHistory] = useState(false);
  const [rate,setRate] = useState(() => (data?.monthlyRate ?? 0) / 100);
  const [clientSearch,setClientSearch] = useState('');
  const [clientForm,setClientForm] = useState(null);
  const [managedClient,setManagedClient] = useState(null);
  const [loanForm,setLoanForm] = useState(initialLoan);
  const [editingLoan,setEditingLoan] = useState(null);
  const [paymentForm,setPaymentForm] = useState(initialPayment);
  const [paymentText,setPaymentText] = useState('');
  const [editingPayment,setEditingPayment] = useState(null);
  const [scheduleFilter,setScheduleFilter] = useState('today');

  useEffect(() => { const change = () => setRoute(location.hash.slice(1) || 'panel'); window.addEventListener('hashchange',change); return () => window.removeEventListener('hashchange',change); }, []);
  useEffect(() => {
    const media=window.matchMedia('(max-width: 900px)');
    const change=event=>{setIsMobile(event.matches);setMenuOpen(!event.matches);};
    media.addEventListener('change',change);
    return () => media.removeEventListener('change',change);
  },[]);
  useEffect(() => {
    if (!(isMobile&&menuOpen)) return;
    const previous=document.body.style.overflow;
    document.body.style.overflow='hidden';
    const escape=event=>{if(event.key==='Escape') setMenuOpen(false);};
    window.addEventListener('keydown',escape);
    return ()=>{document.body.style.overflow=previous;window.removeEventListener('keydown',escape);};
  },[isMobile,menuOpen]);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  function flash(message) {
    clearTimeout(noticeTimer.current);
    setNotice(message);
    if (message) noticeTimer.current = setTimeout(() => setNotice(''),5000);
  }
  async function commit(next, message, restore=false) {
    if ((!data && !restore) || busy.current) { flash('Hay un guardado en curso o el registro no está disponible.'); return false; }
    if (!valid(next)) { flash('El registro contiene datos inválidos.'); return false; }
    busy.current = true; setSaving(true);
    try {
      if (server) {
        const response = await fetch('?api=1', {method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':server.token},body:JSON.stringify({revision:revision.current,data:next,restore})});
        if (response.status === 409) { flash('Hubo cambios en otro dispositivo. Recarga y vuelve a introducir el movimiento.'); return false; }
        if (response.status === 401) { flash('La sesión terminó. Recarga para volver a ingresar.'); return false; }
        if (!response.ok) throw new Error('No se pudo guardar');
        revision.current = (await response.json()).revision;
      } else {
        if (localStorage.getItem(key)!==stored.current) {flash('El registro cambió en otra pestaña. Recarga esta página antes de guardar.');return false;}
        stored.current=JSON.stringify(next);
        localStorage.setItem(key,stored.current);
      }
      setData(withFriends(next)); flash(message); return true;
    } catch { flash('No se pudo confirmar el guardado. Recarga para comprobar si quedó registrado.'); return false; }
    finally { busy.current=false; setSaving(false); }
  }
  const current = today();
  const weekStart = datePlusDays(current,-6);
  const weekEnd = datePlusDays(current,6);
  const loans = data?.loans ?? [];
  const friends = data?.friends ?? [];
  const schedule = useMemo(() => data ? installmentsOf(data) : [],[data]);
  const payments = useMemo(() => data ? paymentsOf(data) : [],[data]);
  const newLoans = loans.filter(loan => loan.type === 'new');
  const recovered = sum(newLoans,loan => Math.min(loan.principal,totalPaid(loan)));
  const previousCapital = sum(loans.filter(loan => loan.type === 'old' && loan.originalPrincipal),
    loan => Math.max(0, Math.min(loan.originalPrincipal, loan.principal) - totalPaid(loan)));
  const overdue = schedule.filter(item => item.left && item.date < current);
  const payable = loans.map((loan,index) => ({loan,label:loanLabel(loan,index)}))
    .filter(option => remaining(option.loan)>0 || editingPayment?.loan.id===option.loan.id);

  function changeLoan(field,value) {
    setLoanForm(previous => {
      const next = {...previous,[field]:value};
      if (!editingLoan && field==='frequency' && next.type==='new') next.count=String({week:4,fortnight:2,month:1}[value]);
      if (!editingLoan && ['frequency','issued','type'].includes(field)) next.first=next.type==='new'?firstDue(next.issued,next.frequency):'';
      if (['principal','frequency','count','type'].includes(field) && next.type==='new') {
        const principal=cents(next.principal), count=Number(next.count), rate=editingLoan?.monthlyRate ?? data?.monthlyRate ?? 0;
        next.amount=principal>0 && count>=1 && count<=120 ? (installmentWithInterest(principal,next.frequency,count,rate)/100).toFixed(2) : '';
      }
      return next;
    });
  }
  function resetLoan() { setEditingLoan(null); setLoanForm(initialLoan()); }
  function openLoan(loan) {
    setEditingLoan(loan);
    setLoanForm({person:loan.person,type:loan.type,principal:String((loan.type==='new'?loan.principal:loan.originalPrincipal??0)/100),issued:loan.issued??'',frequency:loan.frequency,count:String(loan.count),amount:String(loan.amount/100),first:loan.first});
    setManagedClient(null); location.hash='nuevo';
  }
  async function saveLoan(event) {
    event.preventDefault();
    const editing=loans.find(loan => loan.id===editingLoan?.id);
    if (editingLoan && !editing) return flash('El préstamo ya no está disponible.');
    const type=editing?.type ?? loanForm.type, person=editing?.person ?? loanForm.person;
    const count=Number(loanForm.count), entered=cents(loanForm.principal), amount=cents(loanForm.amount);
    const principal=type==='old'?amount*count:entered;
    const originalPrincipal=type==='old'&&entered>0?entered:undefined;
    const issued=type==='old'?'':loanForm.issued;
    if (!friends.some(friend => friend.person===person)) return flash('Selecciona un cliente registrado.');
    if (!Number.isSafeInteger(amount)||amount<1||amount>10000000000) return flash('El monto por cuota debe estar dentro del rango permitido.');
    if (issued && editing?.payments.some(payment => payment.date < issued)) return flash('La fecha de desembolso debe ser igual o anterior a los abonos.');
    if (issued && loanForm.first < issued) return flash('La primera cuota debe vencer en la fecha de desembolso o después.');
    if (principal>10000000000) return flash('El monto excede el máximo permitido.');
    if (type==='new' && principal>cash(data)+(editing?.principal??0)) return flash('El desembolso supera la caja disponible.');
    if (editing && amount*count<totalPaid(editing)) return flash('El total de cuotas debe cubrir los abonos registrados.');
    if (type==='old' && principal>opening(data)+(editing?.principal??0)) return flash('Las cuotas superan el saldo inicial por detallar.');
    if (amount*count<principal) return flash('El total de las cuotas debe cubrir el monto entregado.');
    const rate=type==='new'?(editing?.monthlyRate??data.monthlyRate??0):undefined;
    const item={id:editing?.id??crypto.randomUUID(),person,type,principal,amount,count,first:loanForm.first,frequency:loanForm.frequency,payments:editing?.payments??[],...(issued?{issued}:{}),...(originalPrincipal?{originalPrincipal}:{}),...(rate===undefined?{}:{monthlyRate:rate})};
    const next={...data,loans:editing?loans.map(loan=>loan.id===editing.id?item:loan):[...loans,item]};
    if (await commit(next,editing?'Préstamo actualizado.':'Préstamo registrado.')) resetLoan();
  }
  async function deleteLoan(loan) {
    if (loan.payments.length || !confirm(`¿Eliminar este préstamo de ${loan.person}?`)) return;
    if (await commit({...data,loans:loans.filter(item=>item.id!==loan.id)},'Préstamo eliminado.')) setManagedClient(null);
  }
  async function saveClient(event) {
    event.preventDefault();
    const previous=clientForm.previous;
    const contact={person:clientForm.person.trim(),dni:clientForm.dni.trim(),phone:clientForm.phone.trim(),address:clientForm.address.trim(),whatsappConsent:Boolean(clientForm.whatsappConsent)};
    if (!contact.person) return flash('Escribe el nombre del cliente.');
    if (friends.some(friend => friend.person!==previous && normalize(friend.person)===normalize(contact.person))) return flash('Ya existe un cliente con ese nombre.');
    const next={...data,friends:previous===null?[...friends,contact]:friends.map(friend=>friend.person===previous?contact:friend),loans:loans.map(loan=>loan.person===previous?{...loan,person:contact.person}:loan)};
    if (await commit(next,previous===null?'Cliente creado.':'Cliente actualizado.')) {setClientForm(null);setLoanForm(form=>({...form,person:contact.person}));}
  }
  async function deleteClient(friend) {
    if (loans.some(loan=>loan.person===friend.person)) return flash('Este cliente tiene préstamos en el historial y su ficha se debe conservar.');
    if (confirm(`¿Eliminar a ${friend.person} de la lista de clientes?`) && await commit({...data,friends:friends.filter(item=>item.person!==friend.person)},'Cliente eliminado.')) setClientForm(null);
  }
  async function authorizeAllClients() {
    const pending=friends.filter(friend=>!friend.whatsappConsent);
    if (!pending.length) return flash('Todos los clientes ya tienen la autorización marcada.');
    if (!confirm(`¿Confirmas que los ${pending.length} clientes pendientes ya aceptaron recibir avisos de préstamos y vencimientos por WhatsApp? Se enviarán recordatorios de las cuotas que venzan hoy a quienes tengan un celular válido.`)) return;
    await commit({...data,friends:friends.map(friend=>({...friend,whatsappConsent:true}))},'Autorización actualizada para todos los clientes.');
  }
  function clearPayment() {setEditingPayment(null);setPaymentForm(initialPayment());setPaymentText('');}
  function editPayment(row) {setEditingPayment(row);setPaymentForm({loanId:row.loan.id,amount:String(row.payment.amount/100),date:row.payment.date});setPaymentText(loanLabel(row.loan,loans.indexOf(row.loan)));location.hash='pagos';}
  async function savePayment(event) {
    event.preventDefault();
    const loan=loans.find(item=>item.id===paymentForm.loanId);
    const selected=payable.find(option=>option.loan.id===loan?.id);
    if (!loan || selected?.label!==paymentText) return flash('Selecciona un préstamo de la lista.');
    const previous=editingPayment?.payment, amount=cents(paymentForm.amount), date=paymentForm.date;
    if (previous && !loan.payments.includes(previous)) return flash('El abono ya no está disponible.');
    if (amount<=0 || amount>remaining(loan)+(previous?.amount??0)) return flash('El monto debe ser positivo y caber en el saldo disponible para este abono.');
    if (!validDate(date)||date>current) return flash('Ingresa una fecha de recepción válida que no sea futura.');
    if (loan.issued&&date<loan.issued) return flash('La fecha del abono debe ser igual o posterior al desembolso.');
    const updated=previous?loan.payments.map(payment=>payment===previous?{...payment,amount,date}:payment):[...loan.payments,{amount,date,createdAt:Date.now()}];
    const next={...data,loans:loans.map(item=>item===loan?{...item,payments:updated}:item)};
    if (cash(next)<0) return flash('Si reduces este abono, la caja quedaría en negativo.');
    if (await commit(next,previous?'Abono actualizado.':'Abono registrado.')) {
      if (previous) clearPayment();
      else {
        setPaymentForm(form=>({...form,loanId:'',amount:''}));
        setPaymentText('');
      }
    }
  }
  async function deletePayment(row) {
    if (!confirm(`¿Eliminar el abono de ${money(row.payment.amount)} de ${row.loan.person} del ${dateFormat(row.payment.date)}?`)) return;
    const next={...data,loans:loans.map(loan=>loan===row.loan?{...loan,payments:loan.payments.filter(payment=>payment!==row.payment)}:loan)};
    if (cash(next)<0) return flash('Si eliminas este abono, la caja quedaría en negativo.');
    if (await commit(next,'Abono eliminado.') && editingPayment?.payment===row.payment) clearPayment();
  }
  async function changeCash(type) {
    const amount=cents(cashAmount);
    if (!Number.isSafeInteger(amount)||amount<=0||amount>10000000000) return flash('Ingresa un monto mayor que cero dentro del rango permitido.');
    const description=cashDescription.trim();
    if (!description) return flash('Escribe una descripción del movimiento.');
    if (type==='expense'&&amount>cash(data)) return flash('El egreso supera la caja disponible.');
    const movement={id:crypto.randomUUID(),type,amount,date:current,description};
    if (await commit({...data,cashMovements:[...(data.cashMovements??[]),movement]},type==='income'?'Ingreso registrado.':'Egreso registrado.')) {setCashAmount('');setCashDescription('');}
  }
  async function saveRate(event) {
    event.preventDefault();
    const next={...data};
    if (rate==='') delete next.monthlyRate;
    else {next.monthlyRate=cents(rate);if (!validRate(next.monthlyRate)) return flash('Ingresa un porcentaje válido.');}
    await commit(next,'Tasa mensual guardada.');
  }
  async function restore(file) {
    if (!file) return;
    let snapshot;
    try {snapshot=JSON.parse(await file.text());} catch {return flash('La copia no contiene un registro válido.');}
    if (!valid(snapshot)) return flash('La copia no contiene un registro válido.');
    if (confirm('¿Reemplazar los datos actuales por esta copia de respaldo?')
      && await commit(withFriends(snapshot),'Copia restaurada.',true)) {
      setRate((snapshot.monthlyRate??0)/100);
      resetLoan();
      clearPayment();
    }
  }

  return <div className={`app-shell${menuOpen?'':' menu-collapsed'}`}>
    {isMobile&&menuOpen&&<div className="menu-backdrop" onClick={()=>setMenuOpen(false)} aria-hidden="true" />}
    <aside id="main-menu" inert={!menuOpen} aria-label="Menú principal"><div className="brand"><span className="brand-mark">S/</span><span>Mis préstamos</span></div><nav>{routes.map(([id,label])=><a key={id} href={'#'+id} aria-current={route===id?'page':undefined} onClick={()=>{if(isMobile)setMenuOpen(false);}}>{label}</a>)}</nav>
      {server&&<form method="post"><input type="hidden" name="token" value={server.token}/><button name="logout" value="1">Cerrar sesión</button></form>}</aside>
    <main><header><div className="page-heading"><button className="menu-toggle" type="button" onClick={()=>setMenuOpen(open=>!open)} aria-label={menuOpen?'Ocultar menú':'Mostrar menú'} aria-controls="main-menu" aria-expanded={menuOpen}><span aria-hidden="true">☰</span></button><h1 className={route==='panel'?'panel-title':''}>{routes.find(([id])=>id===route)?.[1]??'Panel principal'}</h1></div><time dateTime={current}>{new Intl.DateTimeFormat('es-PE',{dateStyle:'long',timeZone:'America/Lima'}).format(new Date())}</time></header>
      {notice&&<p className="notice" role="status">{notice}</p>}
      {!data ? <section><h2>Registro no disponible</h2><p>Restaura una copia válida desde Respaldo.</p><input type="file" accept=".json,application/json" onChange={event=>{restore(event.target.files[0]);event.target.value='';}} /></section> : <>
      {route==='panel'&&<>
        <div className="metrics"><Metric label="Caja disponible" value={money(cash(data))} accent/><Metric label="Por cobrar en total" value={money(opening(data)+sum(loans,remaining))}/><Metric label="Capital prestado pendiente" value={money(previousCapital + sum(newLoans,loan=>loan.principal)-recovered)}/><Metric label="Pagos recibidos" value={money(sum(loans,totalPaid))}/></div>
        <div className="dashboard-grid three"><section><h2>Ingreso / egreso de caja</h2><div className="cash-entry-row"><label>Monto (S/)<input type="number" min=".01" max="100000000" step=".01" value={cashAmount} onChange={event=>setCashAmount(event.target.value)} placeholder="0.00"/></label><label>Descripción<input type="text" maxLength="200" value={cashDescription} onChange={event=>setCashDescription(event.target.value)} placeholder="Motivo del movimiento"/></label></div><div className="buttons cash-actions"><button disabled={saving} onClick={()=>changeCash('income')}>Ingreso</button><button className="danger" disabled={saving} onClick={()=>changeCash('expense')}>Egreso</button><button className="secondary" onClick={()=>setCashHistory(true)}>Movimientos</button></div></section>
          <section><h2>Interés mensual</h2><form onSubmit={saveRate}><label>Tasa mensual (%)<input type="number" min="0" step=".01" value={rate} onChange={event=>setRate(event.target.value)}/></label><button disabled={saving}>Guardar tasa</button></form></section>
          <Metric label="Caja disponible + por cobrar" value={money(cash(data)+opening(data)+sum(loans,remaining))} detail="Suma de los dos saldos del panel"/></div>
        <div className="dashboard-grid"><section><h2>Próximos vencimientos</h2><Table headers={['Vence','Cliente','Préstamo','Pendiente']} rows={schedule.filter(item=>item.left&&item.date>=current&&item.date<=weekEnd).map(item=>[dateFormat(item.date),item.loan.person,item.reference,money(item.left)])} emptyText="No hay vencimientos en los próximos 7 días."/></section><section><h2>Estado de cobros</h2><p>Cobrado: <strong>{money(sum(loans,totalPaid))}</strong></p><p>Pendiente registrado: <strong>{money(sum(loans,remaining))}</strong></p><p>Cuotas vencidas: <strong>{money(sum(overdue,item=>item.left))}</strong></p></section></div>
        <section><h2>Últimos pagos</h2><Table headers={['Fecha','Cliente','Préstamo','Abono']} rows={payments.filter(row=>row.payment.date>=weekStart&&row.payment.date<=current).map(row=>[dateFormat(row.payment.date),row.loan.person,row.reference,money(row.payment.amount)])} emptyText="No hay pagos en los últimos 7 días."/></section>
      </>}
      {route==='clientes'&&<section><div className="section-head"><h2>Registro de clientes</h2><div className="buttons">{friends.some(friend=>!friend.whatsappConsent)&&<button type="button" className="secondary" disabled={saving} onClick={authorizeAllClients}>Autorizar avisos a todos</button>}<button onClick={()=>setClientForm({previous:null,person:'',dni:'',phone:'',address:'',whatsappConsent:false})}>Nuevo cliente</button></div></div>
        {clientForm&&<form className="client-form" onSubmit={saveClient}><h3>{clientForm.previous===null?'Nuevo cliente':'Editar cliente'}</h3><div className="form-grid">{[['person','Nombre completo'],['dni','DNI (opcional)'],['phone','Teléfono'],['address','Dirección de referencia']].map(([field,label])=><label key={field}>{label}<input type={field==='phone'?'tel':'text'} inputMode={field==='dni'?'numeric':undefined} value={clientForm[field]} required={field==='person'} maxLength={field==='person'?100:field==='dni'?8:field==='phone'?30:200} onChange={event=>setClientForm(form=>({...form,[field]:event.target.value}))}/></label>)}</div><label className="consent-line"><input type="checkbox" checked={Boolean(clientForm.whatsappConsent)} onChange={event=>setClientForm(form=>({...form,whatsappConsent:event.target.checked}))}/><span>El cliente autorizó recibir avisos de préstamos y vencimientos por WhatsApp</span></label><div className="buttons"><button disabled={saving}>Guardar cliente</button><button type="button" className="secondary" onClick={()=>setClientForm(null)}>Cancelar</button></div></form>}
        <label>Buscar clientes<input type="search" value={clientSearch} onChange={event=>setClientSearch(event.target.value)} placeholder="Nombre, DNI o teléfono"/></label>
        <Table headers={['Nombre','DNI','Teléfono','Dirección de referencia','Avisos WhatsApp','Préstamos','Acciones']} rows={friends.filter(friend=>normalize(`${friend.person} ${friend.dni} ${friend.phone}`).includes(normalize(clientSearch))).sort((a,b)=>a.person.localeCompare(b.person,'es')).map(friend=>[friend.person,friend.dni||'—',friend.phone||'—',friend.address||'—',friend.whatsappConsent?'Autorizado':'Sin autorización',<button onClick={()=>setManagedClient(friend.person)}>Ver préstamos</button>,<div className="buttons" key={friend.person}><button onClick={()=>setClientForm({...friend,previous:friend.person})}>Editar</button><button className="danger-soft" onClick={()=>deleteClient(friend)}>Eliminar</button></div>])} emptyText="Todavía no hay clientes registrados."/>
      </section>}
      {route==='nuevo'&&<section><h2>{editingLoan?'Editar préstamo':'Registrar préstamo'}</h2><form onSubmit={saveLoan}>
        <label>Persona<select value={loanForm.person} disabled={Boolean(editingLoan)} required onChange={event=>changeLoan('person',event.target.value)}><option value="">Selecciona un cliente</option>{friends.map(friend=><option key={friend.person}>{friend.person}</option>)}</select></label>
        <label>Tipo<select value={loanForm.type} disabled={Boolean(editingLoan)} onChange={event=>changeLoan('type',event.target.value)}><option value="new">Nuevo desembolso</option><option value="old">Saldo anterior por detallar</option></select></label>
        <label>{loanForm.type==='old'?'Monto prestado originalmente (S/, opcional)':'Monto prestado (S/)'}<input type="number" min=".01" step=".01" max="100000000" required={loanForm.type==='new'} value={loanForm.principal} onChange={event=>changeLoan('principal',event.target.value)}/></label>
        {loanForm.type==='new'&&<label>Fecha de desembolso<input type="date" min="1900-01-01" max={current} required={!editingLoan||Boolean(editingLoan.issued)} value={loanForm.issued} onChange={event=>changeLoan('issued',event.target.value)}/></label>}
        <label>Frecuencia<select value={loanForm.frequency} onChange={event=>changeLoan('frequency',event.target.value)}><option value="week">Semanal</option><option value="fortnight">Quincenal</option><option value="month">Mensual</option></select></label>
        <label>{loanForm.type==='old'?'Número de cuotas pendientes':({week:'Número de semanas',fortnight:'Número de quincenas',month:'Número de meses'}[loanForm.frequency])}<input type="number" min="1" max="120" required value={loanForm.count} onChange={event=>changeLoan('count',event.target.value)}/></label>
        <label>Monto por cuota (S/)<input type="number" min=".01" step=".01" max="100000000" required value={loanForm.amount} onChange={event=>changeLoan('amount',event.target.value)}/></label>
        <label>Fecha de la primera cuota pendiente<input type="date" min="1900-01-01" max="2200-12-31" required value={loanForm.first} onChange={event=>changeLoan('first',event.target.value)}/></label>
        <p className="muted">{loanForm.amount&&loanForm.count?`Total de las cuotas: ${money(cents(loanForm.amount)*Number(loanForm.count))}`:''}</p><div className="buttons"><button disabled={saving}>Guardar préstamo</button>{editingLoan&&<button type="button" className="secondary" onClick={resetLoan}>Cancelar edición</button>}</div>
      </form></section>}
      {route==='pagos'&&<section><h2>Registrar abono</h2><form onSubmit={savePayment}>
        <label>Préstamo<input list="payable-loans" required disabled={Boolean(editingPayment)} value={paymentText} placeholder="Escribe el nombre o número del préstamo" onChange={event=>{setPaymentText(event.target.value);setPaymentForm(form=>({...form,loanId:payable.find(option=>option.label===event.target.value)?.loan.id??''}));}}/></label><datalist id="payable-loans">{payable.map(option=><option key={option.loan.id} value={option.label}/>)}</datalist>
        <label>Monto recibido (S/)<input type="number" min=".01" step=".01" max="100000000" required value={paymentForm.amount} onChange={event=>setPaymentForm(form=>({...form,amount:event.target.value}))}/></label>
        <label>Fecha de recepción<input type="date" min="1900-01-01" max={current} required value={paymentForm.date} onChange={event=>setPaymentForm(form=>({...form,date:event.target.value}))}/></label>
        <div className="buttons"><button disabled={saving||!payable.length}>{editingPayment?'Guardar cambios':'Guardar abono'}</button>{editingPayment&&<button type="button" className="secondary" onClick={clearPayment}>Cancelar edición</button>}</div></form>
        <p><small>Los abonos se aplican a las cuotas más antiguas primero. Puedes registrar pagos parciales o adelantados.</small></p>
        <Table headers={['Fecha','Cliente','Préstamo','Abono','Saldo tras el abono','Acciones']} rows={payments.map(row=>[dateFormat(row.payment.date),row.loan.person,row.reference,money(row.payment.amount),money(row.balance),<div className="buttons" key={row.order}><button onClick={()=>editPayment(row)}>Editar</button><button className="danger-soft" onClick={()=>deletePayment(row)}>Eliminar</button></div>])} emptyText="Todavía no hay abonos registrados."/>
      </section>}
      {route==='calendario'&&<section><h2>Calendario de cuotas</h2><label>Mostrar<select value={scheduleFilter} onChange={event=>setScheduleFilter(event.target.value)}><option value="today">Vencen hoy</option><option value="pending">Pendientes</option><option value="all">Todas</option></select></label>
        <Table headers={['Vencimiento','Cliente','Préstamo','Cuota','Pendiente','Estado','WhatsApp']} rows={schedule.filter(item=>scheduleFilter==='all'||(item.left>0&&(scheduleFilter==='today'?item.date===current:item.date>current))).map(item=>[dateFormat(item.date),item.loan.person,item.reference,money(item.amount),money(item.left),!item.left?'Pagada':item.date<current?'Vencida':item.date===current?'Vence hoy':'Pendiente',<WhatsAppButton key={`${item.loan.id}-${item.index}`} item={item} data={data}/>])} emptyText="No hay cuotas para mostrar."/>
      </section>}
      {route==='morosidad'&&<section><h2>Morosidad</h2><p>Saldo vencido <strong>{money(sum(overdue,item=>item.left))}</strong></p><Table headers={['Cliente','Cuotas vencidas','Vencimiento más antiguo','Saldo vencido']} rows={[...overdue.reduce((groups,item)=>{const group=groups.get(item.loan.person)??{count:0,total:0,first:item.date};group.count++;group.total+=item.left;groups.set(item.loan.person,group);return groups;},new Map())].map(([person,group])=>[person,group.count,dateFormat(group.first),money(group.total)])} emptyText="No hay cuotas vencidas."/></section>}
      {route==='reportes'&&<section className="loan-list" aria-label="Detalle de préstamos">
        <div className="report-actions"><button type="button" onClick={()=>download(`reporte-prestamos-${current}.csv`,reportCsv(reportRows(loans,current)),'text/csv;charset=utf-8')}>Descargar reporte para Excel</button></div>
        <div className="metrics report-metrics"><Metric label="Ganancia pactada" value={money(sum(newLoans,loan=>loan.amount*loan.count-loan.principal))}/><Metric label="Ganancia cobrada" value={money(sum(newLoans,totalPaid)-recovered)}/><Metric label="Capital recuperado" value={money(recovered)}/><Metric label="Cobros de saldos anteriores" value={money(sum(loans.filter(loan=>loan.type==='old'),totalPaid))}/></div>
        {!loans.length&&<p className="muted">Todavía no hay préstamos registrados.</p>}
        {loans.map((loan,index)=><details className="loan-accordion" key={loan.id}><summary><span>N.º {index+1} · {loan.person} · {frequencyNames[loan.frequency]} · {dateFormat(loan.first)}</span><strong>{remaining(loan)?`${money(remaining(loan))} pendiente`:'Pagado'}</strong></summary><div className="loan-accordion-body"><Table headers={['Vence','Cuota','Pendiente']} rows={schedule.filter(item=>item.loan.id===loan.id).map(item=>[dateFormat(item.date),money(item.amount),money(item.left)])} emptyText="Sin cuotas"/></div></details>)}
      </section>}
      {route==='respaldo'&&<section><h2>Respaldo</h2><p>Los datos se guardan en la base de datos del hosting. Puedes descargar una copia de respaldo.</p><button onClick={()=>download(`prestamos-${current}.json`,JSON.stringify(data,null,2),'application/json')}>Descargar copia</button><label>Restaurar una copia<input type="file" accept=".json,application/json" onChange={event=>{restore(event.target.files[0]);event.target.value='';}}/></label></section>}
      </>}
    </main>
    {cashHistory&&<div className="modal-backdrop" onClick={()=>setCashHistory(false)}><div className="modal" onClick={event=>event.stopPropagation()}><div className="section-head"><h2>Movimientos de caja</h2><button onClick={()=>setCashHistory(false)}>Cerrar</button></div><Table headers={['Fecha','Movimiento','Monto','Descripción']} rows={[...(data?.cashMovements??[])].reverse().map(movement=>[dateFormat(movement.date),movement.type==='income'?'Ingreso':'Egreso',`${movement.type==='income'?'+':'-'}${money(movement.amount)}`,movement.description?.trim()||'—'])} emptyText="No hay movimientos de caja."/></div></div>}
    {managedClient&&<div className="modal-backdrop" onClick={()=>setManagedClient(null)}><div className="modal wide" onClick={event=>event.stopPropagation()}><div className="section-head"><h2>{managedClient}</h2><button onClick={()=>setManagedClient(null)}>Cerrar</button></div><button onClick={()=>{resetLoan();setLoanForm(form=>({...form,person:managedClient}));setManagedClient(null);location.hash='nuevo';}}>Nuevo préstamo</button><p>Saldo pendiente: {money(sum(loans.filter(loan=>loan.person===managedClient),remaining))}</p>{loans.filter(loan=>loan.person===managedClient).map(loan=><article key={loan.id}><h3>{loan.person} · {frequencyNames[loan.frequency]}</h3><p>Saldo pendiente: {money(remaining(loan))} · Cuota: {money(loan.amount)}</p><div className="buttons"><button onClick={()=>openLoan(loan)}>Editar préstamo</button><button className="danger-soft" disabled={loan.payments.length>0} onClick={()=>deleteLoan(loan)}>Eliminar préstamo</button>{remaining(loan)>0&&<button onClick={()=>{const option=payable.find(item=>item.loan.id===loan.id);setPaymentText(option?.label??'');setPaymentForm({loanId:loan.id,amount:'',date:current});setManagedClient(null);location.hash='pagos';}}>Registrar abono</button>}</div><Table headers={['Vence','Cuota','Pendiente']} rows={schedule.filter(item=>item.loan.id===loan.id).map(item=>[dateFormat(item.date),money(item.amount),money(item.left)])} emptyText="Sin cuotas"/></article>)}{!loans.some(loan=>loan.person===managedClient)&&<p>Este cliente no tiene préstamos registrados.</p>}</div></div>}
  </div>;
}

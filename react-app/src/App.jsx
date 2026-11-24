import {useEffect, useMemo, useRef, useState} from 'react';
import {cash, cents, dateFormat, download, due, installmentWithInterest, installmentsOf, money, opening, paymentsOf, remaining, reportCsv, reportRows, sum, today, totalPaid, valid, validDate, validRate, whatsappNumber, withFriends} from './model.js';

const empty = {loans:[], friends:[]};
const key = 'mis-prestamos-v1';
const routes = [['panel','Panel principal'],['clientes','Clientes'],['nuevo','Préstamos'],['calendario','Calendario'],['pagos','Pagos'],['comprobantes','Comprobantes'],['morosidad','Morosidad'],['reportes','Reportes'],['respaldo','Respaldo']];
const frequencyNames = {week:'Semanal',fortnight:'Quincenal',month:'Mensual'};
const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('es');
const firstDue = (issued,frequency) => validDate(issued) ? due(issued,frequency,1) : '';
const datePlusDays = (value,days) => { const date=new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate()+days); return date.toISOString().slice(0,10); };
const loanLabel = (loan,index) => `${loan.person} · N.º ${index+1} · ${frequencyNames[loan.frequency]} · ${dateFormat(loan.first)} · ${money(remaining(loan))} pendiente`;
const initialLoan = () => ({person:'',type:'new',principal:'',issued:today(),frequency:'week',count:'4',amount:'',first:firstDue(today(),'week')});
const initialPayment = () => ({loanId:'',amount:'',date:today()});
// Corte del 22/11/2026: S/ 10,190 por cobrar incluyen 20 % de interés.
// En ese corte ya había S/ 1,600 de capital en préstamos nuevos.
const capitalBase = Math.round(1019000 / 1.2);
const capitalNuevoEnCorte = 160000;

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

function clientLoansMessage(friend,loans,schedule,current) {
  const own=loans.map((loan,index)=>({loan,index})).filter(({loan})=>loan.person===friend.person);
  const lines=[`Hola ${friend.person}, te comparto el estado de tus préstamos al ${dateFormat(current)}.`];
  if (!own.length) lines.push('No tienes préstamos registrados.');
  for (const {loan,index} of own) {
    const parts=schedule.filter(item=>item.loan.id===loan.id).sort((a,b)=>a.index-b.index);
    const payments=[...loan.payments].sort((a,b)=>a.date.localeCompare(b.date)||(a.createdAt??0)-(b.createdAt??0));
    const paidDates=[];
    let paid=0,completed=0;
    for (const payment of payments) {
      paid+=payment.amount;
      while (completed<loan.count&&paid>=loan.amount*(completed+1)) paidDates[completed++]=payment.date;
    }
    lines.push('',`Préstamo N.º ${index+1} (${frequencyNames[loan.frequency]}):`);
    if (paidDates.length) {
      lines.push('Cuotas pagadas:');
      for (const part of parts.filter(item=>item.left===0)) {
        lines.push(`- Cuota ${part.index+1}: ${money(part.amount)}, pagada el ${dateFormat(paidDates[part.index])}.`);
      }
    }
    const pending=parts.filter(item=>item.left>0);
    if (pending.length) {
      lines.push('Cuotas pendientes:');
      for (const part of pending) {
        const partial=part.left<part.amount?` (abonado ${money(part.amount-part.left)})`:'';
        lines.push(`- Cuota ${part.index+1}: vence ${dateFormat(part.date)}, pendiente ${money(part.left)}${partial}.`);
      }
    }
    lines.push(`Saldo pendiente del préstamo: ${money(remaining(loan))}.`);
  }
  return lines.join('\n');
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
  const [showClientPassword,setShowClientPassword] = useState(false);
  const [savedClientAccess,setSavedClientAccess] = useState(null);
  const [clientPasswords,setClientPasswords] = useState(null);
  const [managedClient,setManagedClient] = useState(null);
  const [loanForm,setLoanForm] = useState(initialLoan);
  const [editingLoan,setEditingLoan] = useState(null);
  const [paymentForm,setPaymentForm] = useState(initialPayment);
  const [paymentText,setPaymentText] = useState('');
  const [editingPayment,setEditingPayment] = useState(null);
  const [scheduleFilter,setScheduleFilter] = useState('today');
  const [proofs,setProofs] = useState([]);
  const [analyzingProofId,setAnalyzingProofId] = useState(null);
  const [proofConfirm,setProofConfirm] = useState(null);

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
  useEffect(() => {
    if (!server || route!=='comprobantes') return;
    fetch('clientes-admin.php?action=list')
      .then(response => { if (!response.ok) throw new Error(); return response.json(); })
      .then(setProofs)
      .catch(() => flash('No se pudieron cargar los comprobantes.'));
  },[route,server]);
  useEffect(() => {
    if (!server || route!=='clientes') return;
    fetch('clientes-admin.php?action=access-list')
      .then(response => { if (!response.ok) throw new Error(); return response.json(); })
      .then(rows => {
        const passwords=Object.fromEntries(rows.map(row=>[row.dni,row.clave]));
        setClientPasswords(passwords);
        setClientForm(form=>{
          if (!form?.previous || form.passwordTouched) return form;
          const currentPassword=passwords[form.dni];
          return currentPassword?{...form,password:currentPassword,originalPassword:currentPassword}:form;
        });
      })
      .catch(() => {setClientPasswords(null);flash('No se pudieron mostrar las claves. Revisa la migración y la clave privada del servidor.');});
  },[route,server]);
  function flash(message) {
    clearTimeout(noticeTimer.current);
    setNotice(message);
    if (message) noticeTimer.current = setTimeout(() => setNotice(''),5000);
  }
  async function reviewProof(proof,status) {
    try {
      const response=await fetch('clientes-admin.php?action=review',{
        method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':server.token},
        body:JSON.stringify({id:Number(proof.id),estado:status})
      });
      if (!response.ok) throw new Error();
      setProofs(items=>items.map(item=>item.id===proof.id?{...item,estado:status}:item));
      flash(status==='verificado'?'Comprobante verificado. Registra el abono en Pagos tras comprobar la operación.':'Comprobante rechazado.');
    } catch { flash('No se pudo actualizar el comprobante. Actualiza la página.'); }
  }
  function openProofConfirm(proof,analysis=null) {
    setProofConfirm({
      id:Number(proof.id), proof, analysis,
      amount:analysis?.amount??(Number(proof.monto_centimos)/100).toFixed(2),
      date:analysis?.date??today(),
      receipt:analysis?.receipt??'',
      sender:analysis?.sender??'',
      checked:false,
    });
  }
  async function analyzeProof(proof) {
    setAnalyzingProofId(Number(proof.id));
    try {
      const response=await fetch('clientes-admin.php?action=analyze',{
        method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':server.token},
        body:JSON.stringify({id:Number(proof.id)})
      });
      const result=await response.json();
      if (!response.ok) throw new Error(result.error||'No se pudo analizar la imagen.');
      openProofConfirm(proof,result);
    } catch (error) { flash(error.message); }
    finally { setAnalyzingProofId(null); }
  }
  async function confirmProofPayment() {
    if (!proofConfirm?.checked) return flash('Confirma primero que el dinero aparece en tus movimientos de Yape.');
    const amount=cents(proofConfirm.amount);
    if (!Number.isSafeInteger(amount)||amount<1) return flash('Escribe un monto válido.');
    if (!validDate(proofConfirm.date)||proofConfirm.date>today()) return flash('Revisa la fecha del pago.');
    if (busy.current) return flash('Hay un guardado en curso.');
    busy.current=true; setSaving(true);
    try {
      const response=await fetch('clientes-admin.php?action=confirm-payment',{
        method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':server.token},
        body:JSON.stringify({id:proofConfirm.id,monto_centimos:amount,fecha:proofConfirm.date,
          recibo:proofConfirm.receipt.trim(),remitente:proofConfirm.sender.trim()})
      });
      const result=await response.json();
      if (!response.ok) throw new Error(result.error||'No se pudo registrar el abono.');
      if (!valid(result.data)) throw new Error('El servidor guardó el abono, pero la respuesta no se pudo mostrar. Recarga la página.');
      revision.current=result.revision;
      setData(withFriends(result.data));
      setProofs(items=>items.map(item=>Number(item.id)===proofConfirm.id?{...item,estado:'verificado'}:item));
      setProofConfirm(null);
      flash('Abono registrado y comprobante verificado.');
    } catch (error) { flash(error.message); }
    finally { busy.current=false; setSaving(false); }
  }
  async function commit(next, message, restore=false, clientAccess=null) {
    if ((!data && !restore) || busy.current) { flash('Hay un guardado en curso o el registro no está disponible.'); return false; }
    if (!valid(next)) { flash('El registro contiene datos inválidos.'); return false; }
    busy.current = true; setSaving(true);
    let savedAccessNotice = null;
    try {
      if (server) {
        const response = await fetch('?api=1', {method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':server.token},body:JSON.stringify({revision:revision.current,data:next,restore,...(clientAccess?{client_access:clientAccess}:{})})});
        if (response.status === 409) { flash('Hubo cambios en otro dispositivo. Recarga y vuelve a introducir el movimiento.'); return false; }
        if (response.status === 401) { flash('La sesión terminó. Recarga para volver a ingresar.'); return false; }
        if (!response.ok) {
          const detail=await response.json().catch(()=>null);
          throw new Error(detail?.error||'No se pudo guardar');
        }
        const saved=await response.json();
        revision.current = saved.revision;
        savedAccessNotice = saved.accessNotice ?? null;
        if (saved.accessSecret && clientAccess) {
          next={...next,friends:next.friends.map(friend=>friend.person===clientAccess.person?{...friend,accessSecret:saved.accessSecret}:friend)};
        }
      } else {
        if (localStorage.getItem(key)!==stored.current) {flash('El registro cambió en otra pestaña. Recarga esta página antes de guardar.');return false;}
        stored.current=JSON.stringify(next);
        localStorage.setItem(key,stored.current);
      }
      setData(withFriends(next));
      flash(clientAccess && server
        ? message + (savedAccessNotice === 'queued' ? ' Datos de acceso preparados para WhatsApp.' : ' No se preparó el WhatsApp de acceso; revisa la configuración y autorización.')
        : message);
      return true;
    } catch (error) { flash(error.message&&error.message!=='No se pudo guardar'?error.message:'No se pudo confirmar el guardado. Recarga para comprobar si quedó registrado.'); return false; }
    finally { busy.current=false; setSaving(false); }
  }
  const current = today();
  const weekStart = datePlusDays(current,-6);
  const weekEnd = datePlusDays(current,6);
  const loans = data?.loans ?? [];
  const friends = data?.friends ?? [];
  const proofClient = proofConfirm ? friends.find(friend=>friend.dni===proofConfirm.proof.dni) : null;
  const schedule = useMemo(() => data ? installmentsOf(data) : [],[data]);
  const payments = useMemo(() => data ? paymentsOf(data) : [],[data]);
  const newLoans = loans.filter(loan => loan.type === 'new');
  const recovered = sum(newLoans,loan => Math.min(loan.principal,totalPaid(loan)));
  const capitalPrestadoPendiente = capitalBase + sum(newLoans,loan=>loan.principal) - recovered - capitalNuevoEnCorte;
  const totalPorCobrar = data ? opening(data) + sum(loans,remaining) : 0;
  const interesesGanadosPendientes = Math.max(0,totalPorCobrar - capitalPrestadoPendiente);
  const overdue = schedule.filter(item => item.left && item.date < current);
  const payable = loans.map((loan,index) => ({loan,label:loanLabel(loan,index)}))
    .filter(option => remaining(option.loan)>0 || editingPayment?.loan.id===option.loan.id);

  function changeLoan(field,value) {
    setLoanForm(previous => {
      const next = {...previous,[field]:value};
      if (!editingLoan && field==='frequency' && next.type==='new') next.count=String({week:4,fortnight:2,month:1}[value]);
      if (!editingLoan && ['frequency','issued'].includes(field)) next.first=firstDue(next.issued,next.frequency);
      if (['principal','frequency','count'].includes(field) && next.type==='new') {
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
    const type=editing?.type ?? 'new', person=editing?.person ?? loanForm.person;
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
    const oldFriend=previous===null?null:friends.find(friend=>friend.person===previous);
    const password=clientForm.password??'';
    const contact={person:clientForm.person.trim(),dni:clientForm.dni.trim(),phone:clientForm.phone.trim(),address:clientForm.address.trim(),whatsappConsent:Boolean(clientForm.whatsappConsent)};
    if (oldFriend?.accessSecret && contact.dni===oldFriend.dni) contact.accessSecret=oldFriend.accessSecret;
    const passwordToSave=password && (password!==(clientForm.originalPassword??'') || contact.dni!==oldFriend?.dni) ? password : '';
    if (!contact.person) return flash('Escribe el nombre del cliente.');
    if (!whatsappNumber(contact.phone)) return flash('Escribe un celular peruano válido de 9 dígitos.');
    if (server && !/^\d{8}$/.test(contact.dni)) return flash('El DNI debe tener 8 dígitos.');
    if (contact.dni && !/^\d{8}$/.test(contact.dni)) return flash('El DNI debe tener 8 dígitos.');
    if (contact.dni && friends.some(friend=>friend.person!==previous&&friend.dni===contact.dni)) return flash('Ese DNI ya pertenece a otro cliente.');
    if (friends.some(friend => friend.person!==previous && normalize(friend.person)===normalize(contact.person))) return flash('Ya existe un cliente con ese nombre.');
    if (password && (!contact.dni || password.length<8 || password.length>72)) return flash('Para crear una contraseña, escribe un DNI de 8 dígitos y una clave de 8 a 72 caracteres.');
    if (server && (!oldFriend?.accessSecret || contact.dni!==oldFriend.dni) && !passwordToSave) return flash('Escribe una contraseña de al menos 8 caracteres para el acceso del cliente.');
    if (server && !contact.whatsappConsent) return flash('Marca la autorización para enviar al cliente sus datos de acceso por WhatsApp.');
    const next={...data,friends:previous===null?[...friends,contact]:friends.map(friend=>friend.person===previous?contact:friend),loans:loans.map(loan=>loan.person===previous?{...loan,person:contact.person}:loan)};
    const access=server?{dni:contact.dni,person:contact.person,previous_dni:oldFriend?.dni??'',previous_person:oldFriend?.person??'',password:passwordToSave}:null;
    if (await commit(next,previous===null?'Cliente creado.':'Cliente actualizado.',false,access)) {
      setClientForm(null);
      setShowClientPassword(false);
      setLoanForm(form=>({...form,person:contact.person}));
      if (server) {
        setClientPasswords(current=>{
          const nextPasswords={...(current??{})};
          if (oldFriend?.dni && oldFriend.dni!==contact.dni) delete nextPasswords[oldFriend.dni];
          if (passwordToSave) nextPasswords[contact.dni]=passwordToSave;
          return nextPasswords;
        });
        if (passwordToSave) setSavedClientAccess({person:contact.person,dni:contact.dni,password:passwordToSave});
      }
    }
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
    const updated=previous?loan.payments.map(payment=>payment===previous?{...payment,amount,date}:payment):[...loan.payments,{id:crypto.randomUUID(),amount,date,createdAt:Date.now()}];
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
        <div className="metrics"><Metric label="Caja disponible" value={money(cash(data))} accent/><Metric label="Por cobrar en total" value={money(totalPorCobrar)}/><Metric label="Capital prestado pendiente" value={money(capitalPrestadoPendiente)}/><Metric label="Intereses Ganados Pendiente" value={money(interesesGanadosPendientes)}/></div>
        <div className="dashboard-grid three"><section><h2>Ingreso / egreso de caja</h2><div className="cash-entry-row"><label>Monto (S/)<input type="number" min=".01" max="100000000" step=".01" value={cashAmount} onChange={event=>setCashAmount(event.target.value)} placeholder="0.00"/></label><label>Descripción<input type="text" maxLength="200" value={cashDescription} onChange={event=>setCashDescription(event.target.value)} placeholder="Motivo del movimiento"/></label></div><div className="buttons cash-actions"><button disabled={saving} onClick={()=>changeCash('income')}>Ingreso</button><button className="danger" disabled={saving} onClick={()=>changeCash('expense')}>Egreso</button><button className="secondary" onClick={()=>setCashHistory(true)}>Movimientos</button></div></section>
          <section><h2>Interés mensual</h2><form onSubmit={saveRate}><label>Tasa mensual (%)<input type="number" min="0" step=".01" value={rate} onChange={event=>setRate(event.target.value)}/></label><button disabled={saving}>Guardar tasa</button></form></section>
          <Metric label="Caja disponible + por cobrar" value={money(cash(data)+opening(data)+sum(loans,remaining))} detail="Suma de los dos saldos del panel"/></div>
        <div className="dashboard-grid"><section><h2>Próximos vencimientos</h2><Table headers={['Vence','Cliente','Préstamo','Pendiente']} rows={schedule.filter(item=>item.left&&item.date>=current&&item.date<=weekEnd).map(item=>[dateFormat(item.date),item.loan.person,item.reference,money(item.left)])} emptyText="No hay vencimientos en los próximos 7 días."/></section><section><h2>Estado de cobros</h2><p>Cobrado: <strong>{money(sum(loans,totalPaid))}</strong></p><p>Pendiente registrado: <strong>{money(sum(loans,remaining))}</strong></p><p>Cuotas vencidas: <strong>{money(sum(overdue,item=>item.left))}</strong></p></section></div>
        <section><h2>Últimos pagos</h2><Table headers={['Fecha','Cliente','Préstamo','Abono']} rows={payments.filter(row=>row.payment.date>=weekStart&&row.payment.date<=current).map(row=>[dateFormat(row.payment.date),row.loan.person,row.reference,money(row.payment.amount)])} emptyText="No hay pagos en los últimos 7 días."/></section>
      </>}
      {route==='clientes'&&<section><div className="section-head"><h2>Registro de clientes</h2><div className="buttons">{friends.some(friend=>!friend.whatsappConsent)&&<button type="button" className="secondary" disabled={saving} onClick={authorizeAllClients}>Autorizar avisos a todos</button>}<button onClick={()=>{setShowClientPassword(false);setClientForm({previous:null,person:'',dni:'',phone:'',address:'',password:'',originalPassword:'',whatsappConsent:false});}}>Nuevo cliente</button></div></div>
        {clientForm&&<form className="client-form" onSubmit={saveClient}>
          <h3>{clientForm.previous===null?'Nuevo cliente':'Editar cliente'}</h3>
          <div className="form-grid">
            <label className="client-name">Nombre completo<input value={clientForm.person} required maxLength={100} onChange={event=>setClientForm(form=>({...form,person:event.target.value}))}/></label>
            <label>DNI<input type="text" inputMode="numeric" pattern="[0-9]{8}" maxLength={8} required={Boolean(server)} value={clientForm.dni} onChange={event=>setClientForm(form=>({...form,dni:event.target.value}))}/></label>
            <label>Teléfono celular<input type="tel" required maxLength={30} value={clientForm.phone} onChange={event=>setClientForm(form=>({...form,phone:event.target.value}))}/></label>
            <label>Dirección de referencia<input maxLength={200} value={clientForm.address} onChange={event=>setClientForm(form=>({...form,address:event.target.value}))}/></label>
          </div>
          <div className="password-field">
            <label htmlFor="client-password">Contraseña de acceso</label>
            <div className="password-control">
              <input id="client-password" type={showClientPassword?'text':'password'} autoComplete="new-password" minLength={8} maxLength={72} value={clientForm.password??''} disabled={!server} required={Boolean(server&&(!friends.find(friend=>friend.person===clientForm.previous)?.accessSecret||clientForm.dni.trim()!==friends.find(friend=>friend.person===clientForm.previous)?.dni))} onChange={event=>setClientForm(form=>({...form,password:event.target.value,passwordTouched:true}))}/>
              <button type="button" className="secondary" aria-label={showClientPassword?'Ocultar contraseña':'Mostrar contraseña'} aria-pressed={showClientPassword} disabled={!server} onClick={()=>setShowClientPassword(show=>!show)}>{showClientPassword?'Ocultar':'Mostrar'}</button>
            </div>
          </div>
          <p className="muted">{clientForm.previous===null?'Para dar acceso al cliente, escribe su DNI y una contraseña de al menos 8 caracteres.':'La clave actual aparece aquí si ya fue registrada con esta versión. Escribe otra para cambiarla.'}</p>
          <label className="consent-line"><input type="checkbox" required={Boolean(server)} checked={Boolean(clientForm.whatsappConsent)} onChange={event=>setClientForm(form=>({...form,whatsappConsent:event.target.checked}))}/><span>El cliente autorizó recibir sus datos de acceso y avisos de préstamos por WhatsApp</span></label>
          <div className="buttons"><button disabled={saving}>Guardar cliente</button><button type="button" className="secondary" onClick={()=>setClientForm(null)}>Cancelar</button></div>
        </form>}
        <label>Buscar clientes<input type="search" value={clientSearch} onChange={event=>setClientSearch(event.target.value)} placeholder="Nombre, DNI o teléfono"/></label>
        <Table headers={['Nombre','DNI','Teléfono','Dirección de referencia','Avisos WhatsApp','Clave de acceso','Préstamos','Acciones']} rows={friends.filter(friend=>normalize(`${friend.person} ${friend.dni} ${friend.phone}`).includes(normalize(clientSearch))).sort((a,b)=>a.person.localeCompare(b.person,'es')).map(friend=>[friend.person,friend.dni||'—',friend.phone||'—',friend.address||'—',friend.whatsappConsent?'Autorizado':'Sin autorización',<span className="client-password-cell" key={friend.person}>{!friend.dni?'—':clientPasswords===null?'No disponible':Object.prototype.hasOwnProperty.call(clientPasswords,friend.dni)?(clientPasswords[friend.dni]??'Clave anterior'):'Sin acceso'}</span>,<button onClick={()=>setManagedClient(friend.person)}>Ver préstamos</button>,<div className="buttons" key={friend.person}><button onClick={()=>{setShowClientPassword(false);setClientForm({...friend,previous:friend.person,password:clientPasswords?.[friend.dni]??'',originalPassword:clientPasswords?.[friend.dni]??''});}}>Editar</button><button className="danger-soft" onClick={()=>deleteClient(friend)}>Eliminar</button><button type="button" className="wa-button" title={whatsappNumber(friend.phone)?'Enviar información de préstamos por WhatsApp':'Agrega el teléfono del cliente'} aria-label={`WhatsApp para ${friend.person}`} disabled={!whatsappNumber(friend.phone)} onClick={()=>window.open(`https://wa.me/${whatsappNumber(friend.phone)}?text=${encodeURIComponent(clientLoansMessage(friend,loans,schedule,current))}`,'_blank','noopener,noreferrer')}/></div>])} emptyText="Todavía no hay clientes registrados."/>
      </section>}
      {route==='nuevo'&&<section><h2>{editingLoan?'Editar préstamo':'Registrar préstamo'}</h2><form onSubmit={saveLoan}>
        <label>Persona<select value={loanForm.person} disabled={Boolean(editingLoan)} required onChange={event=>changeLoan('person',event.target.value)}><option value="">Selecciona un cliente</option>{friends.map(friend=><option key={friend.person}>{friend.person}</option>)}</select></label>
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
        <Table headers={['Fecha','Cliente','Préstamo','Abono','Saldo tras el abono','Recibo Yape','Acciones']} rows={payments.map(row=>[dateFormat(row.payment.date),row.loan.person,row.reference,money(row.payment.amount),money(row.balance),row.payment.voucherReference||'—',<div className="buttons" key={row.order}><button onClick={()=>editPayment(row)}>Editar</button><button className="danger-soft" onClick={()=>deletePayment(row)}>Eliminar</button></div>])} emptyText="Todavía no hay abonos registrados."/>
      </section>}
      {route==='calendario'&&<section><h2>Calendario de cuotas</h2><label>Mostrar<select value={scheduleFilter} onChange={event=>setScheduleFilter(event.target.value)}><option value="today">Vencen hoy</option><option value="pending">Pendientes</option><option value="all">Todas</option></select></label>
        <Table headers={['Vencimiento','Cliente','Préstamo','Cuota','Pendiente','Estado','WhatsApp']} rows={schedule.filter(item=>scheduleFilter==='all'||(item.left>0&&(scheduleFilter==='today'?item.date===current:item.date>current))).map(item=>[dateFormat(item.date),item.loan.person,item.reference,money(item.amount),money(item.left),!item.left?'Pagada':item.date<current?'Vencida':item.date===current?'Vence hoy':'Pendiente',<WhatsAppButton key={`${item.loan.id}-${item.index}`} item={item} data={data}/>])} emptyText="No hay cuotas para mostrar."/>
      </section>}
      {route==='comprobantes'&&<section><h2>Capturas de Yape</h2><p>La IA lee los datos del voucher. Confirma el ingreso en Movimientos de Yape antes de registrar el abono.</p>
        <Table headers={['Fecha','Cliente','Préstamo','Monto declarado','Estado','Captura','Acciones']}
          rows={proofs.map(proof=>{
            const friend=friends.find(item=>item.dni===proof.dni);
            const loan=loans.find(item=>item.id===proof.prestamo_id);
            return [proof.creado,friend?.person??proof.dni,loan?loanLabel(loan,loans.indexOf(loan)):proof.prestamo_id,
              money(Number(proof.monto_centimos)),proof.estado,
              <a key={proof.id} href={`clientes-admin.php?action=image&id=${encodeURIComponent(proof.id)}`} target="_blank" rel="noopener noreferrer">Ver captura</a>,
              proof.estado==='pendiente'?<div className="buttons" key={proof.id}><button disabled={analyzingProofId===Number(proof.id)||saving} onClick={()=>analyzeProof(proof)}>{analyzingProofId===Number(proof.id)?'Analizando…':'Analizar voucher'}</button><button className="secondary" disabled={saving} onClick={()=>openProofConfirm(proof)}>Registrar manualmente</button><button className="danger-soft" disabled={saving} onClick={()=>reviewProof(proof,'rechazado')}>Rechazar</button></div>:'—'];
          })} emptyText="Todavía no hay capturas recibidas."/>
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
    {proofConfirm&&<div className="modal-backdrop" onClick={()=>!saving&&setProofConfirm(null)}>
      <div className="modal wide voucher-modal" role="dialog" aria-modal="true" aria-labelledby="voucher-title" onClick={event=>event.stopPropagation()}>
        <div className="section-head"><h2 id="voucher-title">Revisar pago de Yape</h2><button type="button" className="secondary" disabled={saving} onClick={()=>setProofConfirm(null)}>Cerrar</button></div>
        <p>Cliente: <strong>{proofClient?.person??proofConfirm.proof.dni}</strong> · Monto declarado: <strong>{money(Number(proofConfirm.proof.monto_centimos))}</strong></p>
        <div className="voucher-grid">
          <div><img className="voucher-image" src={'clientes-admin.php?action=image&id='+encodeURIComponent(proofConfirm.id)} alt="Captura enviada por el cliente"/></div>
          <div>
            {proofConfirm.analysis&&<div className="voucher-analysis">
              <strong>Lectura de la IA</strong>
              <p>{proofConfirm.analysis.is_yape?'Parece una constancia de Yape.':'La imagen no se reconoce claramente como constancia de Yape.'}</p>
              <dl><dt>Monto</dt><dd>{proofConfirm.analysis.amount??'No legible'}</dd><dt>Enviado por</dt><dd>{proofConfirm.analysis.sender??'No legible'}</dd><dt>Recibido por</dt><dd>{proofConfirm.analysis.recipient??'No legible'}</dd><dt>Fecha y hora</dt><dd>{[proofConfirm.analysis.date,proofConfirm.analysis.time].filter(Boolean).join(' · ')||'No legible'}</dd><dt>Código o recibo</dt><dd>{proofConfirm.analysis.receipt??'No legible'}</dd></dl>
              {proofConfirm.analysis.amount&&cents(proofConfirm.analysis.amount)!==Number(proofConfirm.proof.monto_centimos)&&<p className="voucher-warning">El monto leído no coincide con el declarado por el cliente.</p>}
              {proofConfirm.analysis.sender&&proofClient?.person&&normalize(proofClient.person.split(' ')[0]).length>=3&&!normalize(proofConfirm.analysis.sender).includes(normalize(proofClient.person.split(' ')[0]))&&<p className="voucher-warning">El nombre leído no coincide con el cliente. Confirma si pagó otra persona.</p>}
              {!proofConfirm.analysis.receipt&&<p className="voucher-warning">No se leyó un código de operación. Revísalo en Yape antes de confirmar.</p>}
            </div>}
            <label>Monto que ingresó a Yape (S/)<input type="number" min=".01" max="100000000" step=".01" value={proofConfirm.amount} onChange={event=>setProofConfirm(form=>({...form,amount:event.target.value}))}/></label>
            <label>Fecha del ingreso<input type="date" min="1900-01-01" max={current} value={proofConfirm.date} onChange={event=>setProofConfirm(form=>({...form,date:event.target.value}))}/></label>
            <label>Código o número de operación<input maxLength={80} value={proofConfirm.receipt} onChange={event=>setProofConfirm(form=>({...form,receipt:event.target.value}))}/></label>
            <label>Nombre que envió<input maxLength={160} value={proofConfirm.sender} onChange={event=>setProofConfirm(form=>({...form,sender:event.target.value}))}/></label>
            <label className="voucher-confirm"><input type="checkbox" checked={proofConfirm.checked} onChange={event=>setProofConfirm(form=>({...form,checked:event.target.checked}))}/><span>Confirmo que vi este ingreso en los Movimientos de mi cuenta Yape y revisé el monto.</span></label>
            <button type="button" disabled={saving||!proofConfirm.checked} onClick={confirmProofPayment}>{saving?'Registrando…':'Confirmar ingreso y registrar abono'}</button>
          </div>
        </div>
      </div>
    </div>}
    {savedClientAccess&&<div className="modal-backdrop" onClick={()=>setSavedClientAccess(null)}>
      <div className="modal credential-modal" role="dialog" aria-modal="true" aria-labelledby="saved-access-title" onClick={event=>event.stopPropagation()}>
        <div className="section-head"><h2 id="saved-access-title">Clave de {savedClientAccess.person}</h2><button type="button" className="secondary" onClick={()=>setSavedClientAccess(null)}>Cerrar</button></div>
        <p>La clave nueva quedó guardada. Puedes copiarla para compartirla con el cliente.</p>
        <label>DNI<input readOnly value={savedClientAccess.dni} onFocus={event=>event.target.select()}/></label>
        <label>Clave de acceso<input readOnly value={savedClientAccess.password} onFocus={event=>event.target.select()}/></label>
        <button type="button" onClick={()=>navigator.clipboard.writeText('DNI: '+savedClientAccess.dni+'\nClave: '+savedClientAccess.password).then(()=>flash('Datos copiados.')).catch(()=>flash('No se pudieron copiar los datos.'))}>Copiar DNI y clave</button>
      </div>
    </div>}
    {cashHistory&&<div className="modal-backdrop" onClick={()=>setCashHistory(false)}><div className="modal" onClick={event=>event.stopPropagation()}><div className="section-head"><h2>Movimientos de caja</h2><button onClick={()=>setCashHistory(false)}>Cerrar</button></div><Table headers={['Fecha','Movimiento','Monto','Descripción']} rows={[...(data?.cashMovements??[])].reverse().map(movement=>[dateFormat(movement.date),movement.type==='income'?'Ingreso':'Egreso',`${movement.type==='income'?'+':'-'}${money(movement.amount)}`,movement.description?.trim()||'—'])} emptyText="No hay movimientos de caja."/></div></div>}
    {managedClient&&<div className="modal-backdrop" onClick={()=>setManagedClient(null)}><div className="modal wide" onClick={event=>event.stopPropagation()}><div className="section-head"><h2>{managedClient}</h2><button onClick={()=>setManagedClient(null)}>Cerrar</button></div><button onClick={()=>{resetLoan();setLoanForm(form=>({...form,person:managedClient}));setManagedClient(null);location.hash='nuevo';}}>Nuevo préstamo</button><p>Saldo pendiente: {money(sum(loans.filter(loan=>loan.person===managedClient),remaining))}</p>{loans.filter(loan=>loan.person===managedClient).map(loan=><article key={loan.id}><h3>{loan.person} · {frequencyNames[loan.frequency]}</h3><p>Saldo pendiente: {money(remaining(loan))} · Cuota: {money(loan.amount)}</p><div className="buttons"><button onClick={()=>openLoan(loan)}>Editar préstamo</button><button className="danger-soft" disabled={loan.payments.length>0} onClick={()=>deleteLoan(loan)}>Eliminar préstamo</button>{remaining(loan)>0&&<button onClick={()=>{const option=payable.find(item=>item.loan.id===loan.id);setPaymentText(option?.label??'');setPaymentForm({loanId:loan.id,amount:'',date:current});setManagedClient(null);location.hash='pagos';}}>Registrar abono</button>}</div><Table headers={['Vence','Cuota','Pendiente']} rows={schedule.filter(item=>item.loan.id===loan.id).map(item=>[dateFormat(item.date),money(item.amount),money(item.left)])} emptyText="Sin cuotas"/></article>)}{!loans.some(loan=>loan.person===managedClient)&&<p>Este cliente no tiene préstamos registrados.</p>}</div></div>}
  </div>;
}

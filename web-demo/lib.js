const paths = {
  chat:'M20 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3z',
  layers:'m2 8 10-5 10 5-10 5z M3 12l9 5 9-5 M3 16l9 5 9-5',
  menu:'M3 6h18 M3 12h18 M3 18h18',plus:'M12 4v16 M4 12h16',close:'m6 6 12 12 M18 6 6 18',
  edit:'m14 4 6 6 M3 21l5-1L21 7l-4-4L4 16z',file:'M5 3h9l5 5v13H5z M14 3v6h5 M8 13h8 M8 17h6',
  code:'m7 6-5 6 5 6 M17 6l5 6-5 6 M14 4l-4 16',send:'m3 10 18-7-7 18-3-8z M11 13 21 3',
  arrow:'M4 12h16 M14 6l6 6-6 6',task:'M4 5h16v14H4z M8 9h8 M8 13h5',
  yarn:'M17 16a8.8 8.8 0 1 1 1.5-4.7c0 3.8-2.8 5.9-1.5 7.4 1.1 1.3 3.5.8 5 .8 M5 7a17 17 0 0 1 10 12 M3.5 10a14 14 0 0 1 8 9 M7 4.7a18 18 0 0 1 7 5 M11 3.2l5 3.1 M9 8c2.3-2 4.3-3 6.5-3.1 M11.4 10c2.1-1.9 4.1-3.2 6.3-3.6 M13.2 12.8c2.2-2.1 4.1-3.3 5.5-3.6 M15 15.3l3-2.4'
};
export const $ = id => document.getElementById(id);
export function el(tag, cls='', ...children) {
  const n=document.createElement(tag); if(cls)n.className=cls;
  for(const child of children.flat()) if(child!=null)n.append(child);
  return n;
}
export function icon(key) {
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),path=document.createElementNS(ns,'path');
  for(const [k,v] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(k,v);
  path.setAttribute('d',paths[key]);svg.append(path);return svg;
}
export function btn(label,fn,cls='',symbol='') {
  const n=el('button',cls,...(symbol?[icon(symbol)]:[]),label); n.type='button';
  n.onclick=async()=>{if(n.disabled)return;n.disabled=true;try{await fn()}catch(e){notice(e.message)}finally{n.disabled=false}};
  return n;
}
export function iconBtn(label,fn,symbol) {
  const b=btn('',fn,'icon-btn',symbol);b.title=label;b.setAttribute('aria-label',label);return b;
}
let noticeTimer;
export function notice(msg){const n=$('notice');n.textContent=msg;n.hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>n.hidden=true,6000)}
export function headers(){const token=sessionStorage.getItem('mao-token');return token?{Authorization:'Bearer '+token}:{}}
export async function api(path,body,method=body?'POST':'GET') {
  const response=await fetch('/api/v1'+path,{method,headers:{...headers(),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify({requestId:crypto.randomUUID(),...body}):undefined});
  let data;try{data=await response.json()}catch{data={}}
  if(!response.ok)throw Object.assign(new Error(data.error?.message||data.message||(typeof data.error==='string'?data.error:'请求失败 '+response.status)),{status:response.status,current:data.current});
  return data;
}
export const items = data=>Array.isArray(data)?data:(data?.items??[]);
export const url = value=>encodeURIComponent(value);
export const at = ts=>{if(!ts)return '';const date=new Date(ts);return Number.isNaN(date.getTime())?'':date.toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})};
export const phase = value=>({queued:'待送达',running:'运行中',waiting_input:'等待回应',cancelling:'正在停止',blocked:'受阻',awaiting_review:'待验收',partial:'部分交付',completed:'执行结束',verified:'验收通过',cancelled:'已停止',failed:'失败',uncertain:'送达待核对',waiting:'下一轮待发',held:'已挂起',sent:'已发送',received:'已接收',done:'已处理'}[value]??value??'');
export function form(title,fields,submit,onSave) {
  const dialog=$('dialog');if(dialog.open)dialog.close();
  const f=el('form','',el('h2','',title));dialog.replaceChildren(f);
  const controls={};
  for(const field of fields) {
    const input=el(field.options?'select':field.type==='textarea'?'textarea':'input');
    if(input.tagName==='INPUT')input.type=field.type||'text';
    if(field.options)for(const option of field.options){const o=el('option','',option.name);o.value=option.id;input.append(o)}
    if(field.value!=null)input.value=field.value;input.required=!!field.required;
    input.placeholder=field.placeholder||'';input.autocomplete=field.type==='password'?'current-password':'off';
    controls[field.key]=input;f.append(el('label','field',field.label,input));
  }
  const error=el('div','form-err'),save=el('button','primary',submit);save.type='submit';
  error.setAttribute('role','alert');f.append(error,el('div','dialog-foot',btn('取消',()=>dialog.close(),'secondary'),save));
  f.onsubmit=async event=>{event.preventDefault();if(save.disabled)return;save.disabled=true;error.textContent='';
    try{const values=Object.fromEntries(Object.entries(controls).map(([k,v])=>[k,v.type==='file'?v.files[0]:v.value.trim()]));await onSave(values);if(dialog.open&&f.parentNode===dialog)dialog.close()}
    catch(e){error.textContent=e.message}finally{save.disabled=false}};
  dialog.showModal();
  return {dialog,form:f,controls,save};
}
export async function upload(file,projectId){
  if(file.size>16*1024*1024)throw Error('单个附件不能超过 16 MiB');
  const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(new Error('无法读取附件'));reader.readAsDataURL(file)});
  return api('/attachments',{name:file.name,contentType:file.type||'application/octet-stream',data,...(projectId?{projectId}:{})});
}
export async function download(id) {
  const response=await fetch('/api/v1/attachments/'+url(id)+'?download=1',{headers:headers()});
  if(!response.ok)throw Error('无法下载附件（'+response.status+'）');
  const encoded=response.headers.get('Content-Disposition')?.split("filename*=UTF-8''")[1];
  const a=el('a');a.href=URL.createObjectURL(await response.blob());a.download=encoded?decodeURIComponent(encoded):'附件';
  a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
export const state={threads:[],instances:[],projects:[],view:'chat',thread:null,project:null,page:null,snapshot:null};

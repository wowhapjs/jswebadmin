import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile), PORT=31000;
const json=(res,code,obj)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(obj));};
async function sh(cmd,args=[],opts={}){return (await exec(cmd,args,{timeout:opts.timeout||15000,maxBuffer:opts.maxBuffer||12*1024*1024})).stdout.trim();}
async function psql(q){return sh('sudo',['-n','-u','ubuntu','psql','-U','web_manager','-d','web_manager','-At','-F','\t','-v','ON_ERROR_STOP=1','-c',q]);}
const esc=s=>String(s).replaceAll("'","''");
const GITHUB={
  'web-admin':'https://github.com/wowhapjs/jswebadmin',
  'rwanda-news':'https://github.com/wowhapjs/jsrwnews',
  'juwon-english':'https://github.com/wowhapjs/jsjohnenglish'
};
const HOST_TO_SLUG={
  'jswebadmin.duckdns.org':'web-admin',
  'jsrdnews.duckdns.org':'rwanda-news',
  'jsjohnenglish.duckdns.org':'juwon-english'
};

async function providers(){
  const r=await psql("select p.id,coalesce(p.label,p.provider_name),p.status,coalesce(string_agg(d.hostname,',' order by d.hostname),'') from manager.dns_providers p left join manager.dns_provider_domains d on d.provider_id=p.id group by p.id order by coalesce(p.label,p.provider_name)");
  return r.split('\n').filter(Boolean).map(x=>{const [id,label,status,domains]=x.split('\t');return{id,provider:'DuckDNS',label,status,domains:domains?domains.split(','):[]};});
}

function kigaliDate(ms){
  const p=new Intl.DateTimeFormat('en-US',{timeZone:'Africa/Kigali',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ms));
  const o=Object.fromEntries(p.map(x=>[x.type,x.value])); return `${o.year}-${o.month}-${o.day}`;
}
let visitorsCache={at:0,data:{}};
async function visitorStats(){
  if(Date.now()-visitorsCache.at<60000)return visitorsCache.data;
  const days=[]; for(let i=13;i>=0;i--)days.push(kigaliDate(Date.now()-i*86400000));
  const sets={}; for(const slug of Object.values(HOST_TO_SLUG))sets[slug]=Object.fromEntries(days.map(d=>[d,new Set()]));
  try{
    const raw=await sh('journalctl',['-u','caddy','--since','-15 days','--no-pager','-o','cat'],{timeout:20000,maxBuffer:24*1024*1024});
    for(const line of raw.split('\n')){
      if(!line.startsWith('{'))continue;
      let o; try{o=JSON.parse(line)}catch{continue}
      if(!String(o.logger||'').startsWith('http.log.access'))continue;
      const req=o.request||{},host=String(req.host||'').split(':')[0].toLowerCase(),slug=HOST_TO_SLUG[host];
      if(!slug)continue;
      const ts=Number(o.ts); if(!Number.isFinite(ts))continue;
      const day=kigaliDate(ts*1000); if(!sets[slug][day])continue;
      let ip=String(req.client_ip||req.remote_ip||req.remote_addr||'');
      if(ip.startsWith('['))ip=ip.slice(1).split(']')[0]; else if((ip.match(/:/g)||[]).length===1)ip=ip.split(':')[0];
      if(ip)sets[slug][day].add(ip);
    }
  }catch{}
  const data={}; for(const [slug,byDay] of Object.entries(sets))data[slug]=days.map(date=>({date,count:byDay[date].size}));
  visitorsCache={at:Date.now(),data}; return data;
}

async function desktop(){
  const unit='desktop-commander-remote.service';
  const service=await sh('systemctl',['is-active',unit]).catch(e=>(e.stdout||'inactive').trim());
  const cg=await sh('systemctl',['show',unit,'-p','ControlGroup','--value']).catch(()=>'');
  let cgroupPids=[]; try{cgroupPids=(await fs.readFile('/sys/fs/cgroup'+cg+'/cgroup.procs','utf8')).trim().split(/\s+/).filter(Boolean);}catch{}
  const mainPid=await sh('systemctl',['show',unit,'-p','MainPID','--value']).catch(()=>'0');
  const directChildren=mainPid!=='0'?(await sh('pgrep',['-P',mainPid]).catch(()=>'')).split(/\s+/).filter(Boolean):[];
  const processes=(mainPid!=='0'?1:0)+directChildren.length;
  const all=await sh('pgrep',['-f','desktop-commander.*remote']).catch(()=>''), allPids=all.split(/\s+/).filter(Boolean), own=new Set(cgroupPids);
  const duplicates=allPids.filter(x=>!own.has(x)).length;
  return{service,processes,duplicates};
}
async function terminal(){
  const out=await sh('journalctl',['-u','desktop-commander-remote.service','-n','120','--no-pager','-o','short-iso']).catch(e=>(e.stdout||e.stderr||''));
  return{output:out};
}

async function stats(){
  const mem=(await fs.readFile('/proc/meminfo','utf8')).split('\n').reduce((a,l)=>{const x=l.match(/^(\w+):\s+(\d+)/);if(x)a[x[1]]=+x[2]*1024;return a;},{});
  const load=(await fs.readFile('/proc/loadavg','utf8')).trim().split(/\s+/).slice(0,3).map(Number);
  const d=(await sh('df',['-B1','--output=size,used,avail,pcent','/'])).split('\n').pop().trim().split(/\s+/);
  const managerDbBytes=+await psql("select pg_database_size('web_manager')");
  const visits=await visitorStats();
  const raw=await psql("select s.id,s.slug,s.name,coalesce(s.port,0),s.status,s.health_status,coalesce(x.hostname,''),s.server_path,coalesce(db.database_name,'') from manager.sites s left join lateral(select hostname from manager.site_domains where site_id=s.id and is_primary=true limit 1)x on true left join lateral(select database_name from manager.site_databases where site_id=s.id and status='active' order by created_at limit 1) db on true where s.archived_at is null order by s.port");
  const sites=[];
  for(const l of raw.split('\n').filter(Boolean)){
    const [id,slug,name,port,status,health,domain,serverPath,dbName]=l.split('\t');
    let dirBytes=0,dbBytes=0; try{dirBytes=+(await sh('du',['-sb',serverPath])).split(/\s+/)[0];}catch{}
    if(dbName){try{dbBytes=+await psql(`select pg_database_size('${esc(dbName)}')`);}catch{}}
    else if(slug==='web-admin')dbBytes=managerDbBytes;
    sites.push({id,slug,name,port:+port,status,health,domain,dirBytes,dbBytes,dbName:dbName||null,githubUrl:GITHUB[slug]||null,visitors:visits[slug]||[]});
  }
  return{time:new Date().toISOString(),cpuCount:os.cpus().length,memory:{total:mem.MemTotal,used:mem.MemTotal-mem.MemAvailable},load,disk:{total:+d[0],used:+d[1],available:+d[2]},managerDbBytes,sites};
}

async function body(req){let s='';for await(const ch of req){s+=ch;if(s.length>65536)throw new Error('body too large');}return JSON.parse(s||'{}');}
async function saveDuckDNS(b){
  let id=String(b.id||''),label=String(b.label||'').trim().toLowerCase(),apiKey=String(b.apiKey||'').trim();
  const domains=[...new Set(String(b.domains||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean).map(x=>x.endsWith('.duckdns.org')?x:x+'.duckdns.org'))];
  if(!/^[a-z0-9_-]{1,40}$/.test(label))throw Object.assign(new Error('invalid label'),{status:400});
  if(domains.some(x=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.duckdns\.org$/.test(x)))throw Object.assign(new Error('invalid DuckDNS domain'),{status:400});
  if(apiKey.includes('\n')||apiKey.includes('\r'))throw Object.assign(new Error('invalid API key'),{status:400});
  const existing=id?await psql(`select id,credential_ref from manager.dns_providers where id='${esc(id)}'`):'';
  if(!existing&&!apiKey)throw Object.assign(new Error('API key required for new label'),{status:400});
  let providerId=id,cred='';
  if(existing){[providerId,cred]=existing.split('\t'); if(!(cred==='/etc/web-manager/secrets/duckdns.env'||cred.startsWith('/etc/web-manager/secrets/duckdns/')))throw Object.assign(new Error('invalid credential path'),{status:400});}
  else{
    const dupe=await psql(`select id from manager.dns_providers where provider_type='dynamic_dns' and label='${esc(label)}'`); if(dupe)throw Object.assign(new Error('label already exists'),{status:409});
    providerId=(await sh('python3',['-c','import uuid;print(uuid.uuid4())'])).trim(); cred=`/etc/web-manager/secrets/duckdns/${label}.env`;
    await psql(`insert into manager.dns_providers(id,provider_name,provider_type,credential_ref,status,config,label) values ('${providerId}','duckdns:${esc(label)}','dynamic_dns','${esc(cred)}','active','{"api":"https://www.duckdns.org/update","managed_by":"main_admin_direct"}'::jsonb,'${esc(label)}')`);
  }
  if(apiKey){await sh('install',['-d','-m','700','-o','root','-g','root','/etc/web-manager/secrets/duckdns']); const tmp=`/tmp/duckdns-${providerId}.env`;await fs.writeFile(tmp,`DUCKDNS_TOKEN=${apiKey}\n`,{mode:0o600});await sh('install',['-m','600','-o','root','-g','root',tmp,cred]);await fs.unlink(tmp);}
  await psql(`update manager.dns_providers set label='${esc(label)}',provider_name=case when provider_name='duckdns' then provider_name else 'duckdns:${esc(label)}' end,updated_at=now() where id='${providerId}'; delete from manager.dns_provider_domains where provider_id='${providerId}'; ${domains.map(d=>`insert into manager.dns_provider_domains(provider_id,hostname) values ('${providerId}','${esc(d)}') on conflict(provider_id,hostname) do nothing;`).join(' ')}`);
  return{id:providerId};
}

http.createServer(async(req,res)=>{
  try{
    if(req.method==='GET'&&req.url==='/api/stats')return json(res,200,await stats());
    if(req.method==='GET'&&req.url==='/api/providers')return json(res,200,await providers());
    if(req.method==='GET'&&req.url==='/api/desktop')return json(res,200,await desktop());
    if(req.method==='GET'&&req.url==='/api/terminal')return json(res,200,await terminal());
    if(req.method==='POST'&&req.url==='/api/desktop/start'){await fs.unlink('/run/desktop-commander-manual-stop').catch(()=>{});await sh('systemctl',['start','desktop-commander-remote.service']);return json(res,200,{ok:true,...await desktop()});}
    if(req.method==='POST'&&req.url==='/api/desktop/stop'){await fs.writeFile('/run/desktop-commander-manual-stop','manual stop via web-admin\n');await sh('systemctl',['stop','desktop-commander-remote.service']);return json(res,200,{ok:true,service:'inactive'});}
    if(req.method==='POST'&&req.url==='/api/duckdns'){const r=await saveDuckDNS(await body(req));return json(res,200,{ok:true,...r});}
    if(req.method==='GET'&&(req.url==='/'||req.url==='/index.html')){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(await fs.readFile('/srv/sites/web-admin/app/index.html'));}
    res.writeHead(404);res.end();
  }catch(e){json(res,e.status||500,{error:e.message||'server error'});}
}).listen(PORT,'127.0.0.1');

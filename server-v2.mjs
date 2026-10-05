import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile), PORT=31000;
const COMMON_HEADERS={
  'cache-control':'no-store',
  'x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer',
  'x-frame-options':'DENY'
};
const json=(res,code,obj)=>{res.writeHead(code,{...COMMON_HEADERS,'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(obj));};
async function sh(cmd,args=[],opts={}){return (await exec(cmd,args,{timeout:opts.timeout||15000,maxBuffer:opts.maxBuffer||12*1024*1024,cwd:opts.cwd,env:opts.env||process.env})).stdout.trim();}
async function psql(q){return sh('/usr/bin/psql',['-U','web_manager','-d','web_manager','-At','-F','\t','-v','ON_ERROR_STOP=1','-c',q]);}
async function privileged(...args){return sh('/usr/bin/sudo',['-n','/usr/local/sbin/web-admin-priv',...args]);}
const esc=s=>String(s).replaceAll("'","''");
const httpError=(status,message)=>Object.assign(new Error(message),{status});

function requireWriteGuard(req){
  if(req.headers['x-web-admin-request']!=='1')throw httpError(403,'write guard required');
  const fetchSite=String(req.headers['sec-fetch-site']||'');
  if(fetchSite&&!['same-origin','none'].includes(fetchSite))throw httpError(403,'cross-site request blocked');
  const origin=String(req.headers.origin||'');
  if(origin){
    let u; try{u=new URL(origin);}catch{throw httpError(403,'invalid origin');}
    if(u.host!==String(req.headers.host||''))throw httpError(403,'origin mismatch');
  }
}
async function audit(eventType,message,metadata={}){
  const meta=esc(JSON.stringify(metadata));
  await psql(`insert into manager.events(event_type,severity,message,metadata) values ('${esc(eventType)}','info','${esc(message)}','${meta}'::jsonb)`).catch(()=>{});
}

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
  const mapRows=await psql("select s.slug,d.hostname from manager.sites s join manager.site_domains d on d.site_id=s.id where s.archived_at is null");
  const hostToSlug={},slugs=new Set();
  for(const row of mapRows.split('\n').filter(Boolean)){const [slug,host]=row.split('\t');hostToSlug[String(host||'').toLowerCase()]=slug;slugs.add(slug);}
  const days=[]; for(let i=13;i>=0;i--)days.push(kigaliDate(Date.now()-i*86400000));
  const sets={}; for(const slug of slugs)sets[slug]=Object.fromEntries(days.map(d=>[d,new Set()]));
  try{
    const raw=await sh('/usr/bin/journalctl',['-u','caddy','--since','-15 days','--no-pager','-o','cat'],{timeout:20000,maxBuffer:24*1024*1024});
    for(const line of raw.split('\n')){
      if(!line.startsWith('{'))continue;
      let o; try{o=JSON.parse(line)}catch{continue}
      if(!String(o.logger||'').startsWith('http.log.access'))continue;
      const req=o.request||{},host=String(req.host||'').split(':')[0].toLowerCase(),slug=hostToSlug[host];
      if(!slug)continue;
      const ts=Number(o.ts); if(!Number.isFinite(ts))continue;
      const day=kigaliDate(ts*1000); if(!sets[slug]?.[day])continue;
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
  const service=await sh('/usr/bin/systemctl',['is-active',unit]).catch(e=>String(e.stdout||'inactive').trim());
  const cg=await sh('/usr/bin/systemctl',['show',unit,'-p','ControlGroup','--value']).catch(()=>'');
  let cgroupPids=[]; try{cgroupPids=(await fs.readFile('/sys/fs/cgroup'+cg+'/cgroup.procs','utf8')).trim().split(/\s+/).filter(Boolean);}catch{}
  const mainPid=await sh('/usr/bin/systemctl',['show',unit,'-p','MainPID','--value']).catch(()=>'0');
  const directChildren=mainPid!=='0'?(await sh('/usr/bin/pgrep',['-P',mainPid]).catch(()=>'')).split(/\s+/).filter(Boolean):[];
  const processes=(mainPid!=='0'?1:0)+directChildren.length;
  const all=await sh('/usr/bin/pgrep',['-f','desktop-commander.*remote']).catch(()=>''),allPids=all.split(/\s+/).filter(Boolean),own=new Set(cgroupPids);
  const duplicates=allPids.filter(x=>!own.has(x)).length;
  return{service,processes,duplicates};
}
async function terminal(cursor=''){
  const safeCursor=/^[A-Za-z0-9;:=._-]{1,512}$/.test(cursor)?cursor:'';
  const args=['-u','desktop-commander-remote.service','--no-pager','-o','short-iso','--show-cursor'];
  if(safeCursor)args.push('--after-cursor',safeCursor,'-n','120'); else args.push('-n','80');
  const raw=await sh('/usr/bin/journalctl',args,{maxBuffer:2*1024*1024}).catch(e=>String(e.stdout||e.stderr||''));
  const m=raw.match(/(?:^|\n)-- cursor: ([^\n]+)\s*$/);
  const next=m?m[1].trim():safeCursor||null;
  const output=raw.replace(/(?:^|\n)-- cursor: [^\n]+\s*$/,'').trim();
  return{output,cursor:next};
}

const githubHeadCache=new Map(),sizeCache=new Map();
let managerDbCache={at:0,value:0},statsCache={at:0,data:null};
function githubWebUrl(remote){
  let u=String(remote||'').trim();
  if(u.startsWith('git@github.com:'))u='https://github.com/'+u.slice('git@github.com:'.length);
  if(u.startsWith('ssh://git@github.com/'))u='https://github.com/'+u.slice('ssh://git@github.com/'.length);
  return u.replace(/\.git$/,'');
}
function normalizeRemote(remote){return githubWebUrl(remote).replace(/\/$/,'').toLowerCase();}
async function githubHead(remote,branch='main'){
  if(!remote)return null;
  const key=`${remote}|${branch}`,cached=githubHeadCache.get(key); if(cached&&Date.now()-cached.at<60000)return cached.sha;
  try{const out=await sh('/usr/bin/git',['ls-remote',remote,`refs/heads/${branch}`],{timeout:10000});const sha=(out.split(/\s+/)[0]||'').toLowerCase();const val=/^[0-9a-f]{40}$/.test(sha)?sha:null;githubHeadCache.set(key,{at:Date.now(),sha:val});return val;}catch{githubHeadCache.set(key,{at:Date.now(),sha:null});return null;}
}
async function gitInfo(repo,expectedRemote,branch='main'){
  try{
    const base=['-c',`safe.directory=${repo}`,'-C',repo];
    const [localRemote,localSha]=await Promise.all([sh('/usr/bin/git',[...base,'remote','get-url','origin']),sh('/usr/bin/git',[...base,'rev-parse','HEAD'])]);
    const remote=expectedRemote||localRemote,remoteMismatch=!!expectedRemote&&normalizeRemote(localRemote)!==normalizeRemote(expectedRemote);
    return{localRemote,remote,remoteMismatch,githubUrl:githubWebUrl(remote),localSha:localSha.toLowerCase(),githubHead:await githubHead(remote,branch)};
  }catch{return{localRemote:null,remote:expectedRemote||null,remoteMismatch:false,githubUrl:githubWebUrl(expectedRemote),localSha:null,githubHead:null};}
}
async function managerDbSize(){
  if(Date.now()-managerDbCache.at<15000)return managerDbCache.value;
  managerDbCache={at:Date.now(),value:+await psql("select pg_database_size('web_manager')")};
  return managerDbCache.value;
}
async function siteStorage(slug,serverPath,dbName,managerDbBytes){
  const key=`${slug}|${serverPath}|${dbName}`,cached=sizeCache.get(key); if(cached&&Date.now()-cached.at<45000)return cached.value;
  let dirBytes=0,dbBytes=0;
  try{dirBytes=+(await sh('/usr/bin/du',['-sb',serverPath],{timeout:10000})).split(/\s+/)[0];}catch{}
  if(dbName){try{dbBytes=+await psql(`select pg_database_size('${esc(dbName)}')`);}catch{}}
  else if(slug==='web-admin')dbBytes=managerDbBytes;
  const value={dirBytes,dbBytes}; sizeCache.set(key,{at:Date.now(),value}); return value;
}

async function stats(){
  if(statsCache.data&&Date.now()-statsCache.at<2000)return{...statsCache.data,time:new Date().toISOString()};
  const mem=(await fs.readFile('/proc/meminfo','utf8')).split('\n').reduce((a,l)=>{const x=l.match(/^(\w+):\s+(\d+)/);if(x)a[x[1]]=+x[2]*1024;return a;},{});
  const load=(await fs.readFile('/proc/loadavg','utf8')).trim().split(/\s+/).slice(0,3).map(Number);
  const d=(await sh('/usr/bin/df',['-B1','--output=size,used,avail,pcent','/'])).split('\n').pop().trim().split(/\s+/);
  const managerDbBytes=await managerDbSize(),visits=await visitorStats();
  const raw=await psql("select s.id,s.slug,s.name,coalesce(s.port,0),s.status,s.health_status,coalesce(x.hostname,''),s.server_path,coalesce(db.database_name,''),coalesce(s.current_commit,''),coalesce(s.repo_url,''),coalesce(s.repo_branch,'main'),coalesce(ld.status,''),coalesce(ld.message,'') from manager.sites s left join lateral(select hostname from manager.site_domains where site_id=s.id and is_primary=true limit 1)x on true left join lateral(select database_name from manager.site_databases where site_id=s.id and status='active' order by created_at limit 1) db on true left join lateral(select status,message from manager.deployments where site_id=s.id order by created_at desc limit 1) ld on true where s.archived_at is null order by s.port");
  const sites=[];
  for(const l of raw.split('\n').filter(Boolean)){
    const [id,slug,name,port,status,health,domain,serverPath,dbName,currentCommit,repoUrl,repoBranch,lastDeployStatus,lastDeployMessage]=l.split('\t');
    const storage=await siteStorage(slug,serverPath,dbName,managerDbBytes),gi=await gitInfo(serverPath,repoUrl||null,repoBranch||'main'),deployedSha=currentCommit||null;
    let syncStatus='unknown';
    if(gi.remoteMismatch)syncStatus='drift';
    else if(deployedSha&&gi.localSha&&gi.localSha!==deployedSha)syncStatus='drift';
    else if(deployedSha&&gi.githubHead===deployedSha)syncStatus='sync';
    else if(deployedSha&&gi.githubHead)syncStatus='behind';
    sites.push({id,slug,name,port:+port,status,health,domain,...storage,dbName:dbName||null,repoUrl:repoUrl||null,repoBranch:repoBranch||'main',githubUrl:gi.githubUrl,githubHead:gi.githubHead,localSha:gi.localSha,deployedSha,syncStatus,remoteMismatch:gi.remoteMismatch,lastDeployStatus:lastDeployStatus||null,lastDeployMessage:lastDeployMessage||null,visitors:visits[slug]||[]});
  }
  const data={time:new Date().toISOString(),cpuCount:os.cpus().length,memory:{total:mem.MemTotal,used:mem.MemTotal-mem.MemAvailable},load,disk:{total:+d[0],used:+d[1],available:+d[2]},managerDbBytes,sites};
  statsCache={at:Date.now(),data}; return data;
}

async function body(req){
  if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw httpError(415,'application/json required');
  let s='';for await(const ch of req){s+=ch;if(s.length>65536)throw httpError(413,'body too large');}
  try{return JSON.parse(s||'{}');}catch{throw httpError(400,'invalid JSON');}
}
async function saveDuckDNS(b){
  const id=String(b.id||''),label=String(b.label||'').trim().toLowerCase(),apiKey=String(b.apiKey||'').trim();
  const domains=[...new Set(String(b.domains||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean).map(x=>x.endsWith('.duckdns.org')?x:x+'.duckdns.org'))];
  if(id&&!/^[0-9a-f-]{36}$/i.test(id))throw httpError(400,'invalid provider id');
  if(!/^[a-z0-9_-]{1,40}$/.test(label))throw httpError(400,'invalid label');
  if(domains.length<1||domains.length>50)throw httpError(400,'at least one registered domain is required');
  if(domains.some(x=>!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.duckdns\.org$/.test(x)))throw httpError(400,'invalid DuckDNS domain');
  if(apiKey.length>512||apiKey.includes('\n')||apiKey.includes('\r'))throw httpError(400,'invalid API key');

  const existing=id?await psql(`select id,coalesce(label,''),credential_ref from manager.dns_providers where id='${esc(id)}' and provider_type='dynamic_dns' limit 1`):'';
  if(id&&!existing)throw httpError(404,'provider not found');
  let providerId=id||randomUUID(),cred=`/etc/web-manager/secrets/duckdns/${label}.env`;
  if(existing){
    const [existingId,existingLabel,existingCred]=existing.split('\t');providerId=existingId;
    if(existingLabel!==label)throw httpError(409,'DuckDNS label is immutable; create a new label instead');
    if(existingCred!==cred)throw httpError(409,'credential path does not match managed secret layout');
    const old=(await psql(`select hostname from manager.dns_provider_domains where provider_id='${esc(providerId)}' order by hostname`)).split('\n').filter(Boolean);
    const removed=old.filter(x=>!domains.includes(x));
    if(removed.length)throw httpError(409,'registered domains cannot be removed by Save; explicit domain deletion is required');
  }else{
    if(!apiKey)throw httpError(400,'API key required for a new label');
    if(await psql(`select id from manager.dns_providers where provider_type='dynamic_dns' and label='${esc(label)}' limit 1`))throw httpError(409,'label already exists');
  }

  const list=domains.map(d=>`'${esc(d)}'`).join(',');
  const conflict=await psql(`select hostname from manager.dns_provider_domains where provider_id<>'${esc(providerId)}' and hostname in (${list}) limit 1`);
  if(conflict)throw httpError(409,`domain already belongs to another DuckDNS label: ${conflict}`);

  let staged='-';
  if(apiKey){staged=`/run/web-admin/duckdns-${randomUUID()}.env`;await fs.writeFile(staged,`DUCKDNS_TOKEN=${apiKey}\n`,{mode:0o600});}
  try{await privileged('duckdns-apply',label,domains.join(','),staged);}finally{if(staged!=='-')await fs.unlink(staged).catch(()=>{});}

  const domainSql=domains.map(d=>`insert into manager.dns_provider_domains(provider_id,hostname) values ('${providerId}','${esc(d)}') on conflict(hostname) do update set provider_id=excluded.provider_id;`).join(' ');
  const providerSql=existing
    ?`update manager.dns_providers set status='active',credential_ref='${esc(cred)}',updated_at=now() where id='${providerId}';`
    :`insert into manager.dns_providers(id,provider_name,provider_type,credential_ref,status,config,label) values ('${providerId}','duckdns:${esc(label)}','dynamic_dns','${esc(cred)}','active','{"api":"https://www.duckdns.org/update","managed_by":"main_admin_direct"}'::jsonb,'${esc(label)}');`;
  await psql(`begin; set transaction isolation level serializable; ${providerSql} ${domainSql} commit;`);
  await audit('duckdns_provider_saved',`DuckDNS provider saved: ${label}`,{provider_id:providerId,label,domains});
  return{id:providerId};
}

http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url||'/','http://localhost');
    if(req.method==='GET'&&u.pathname==='/api/stats')return json(res,200,await stats());
    if(req.method==='GET'&&u.pathname==='/api/providers')return json(res,200,await providers());
    if(req.method==='GET'&&u.pathname==='/api/desktop')return json(res,200,await desktop());
    if(req.method==='GET'&&u.pathname==='/api/terminal')return json(res,200,await terminal(u.searchParams.get('cursor')||''));
    if(req.method==='POST')requireWriteGuard(req);
    if(req.method==='POST'&&u.pathname==='/api/desktop/start'){await privileged('desktop-start');await audit('desktop_commander_started','Desktop Commander started from web-admin');return json(res,200,{ok:true,...await desktop()});}
    if(req.method==='POST'&&u.pathname==='/api/desktop/stop'){await privileged('desktop-stop');await audit('desktop_commander_stopped','Desktop Commander stopped from web-admin');return json(res,200,{ok:true,service:'inactive'});}
    if(req.method==='POST'&&u.pathname==='/api/duckdns'){const r=await saveDuckDNS(await body(req));return json(res,200,{ok:true,...r});}
    if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/index.html')){
      res.writeHead(200,{...COMMON_HEADERS,'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
      return res.end(await fs.readFile('/srv/sites/web-admin/app/index.html'));
    }
    res.writeHead(404,COMMON_HEADERS);res.end();
  }catch(e){json(res,e.status||500,{error:e.message||'server error'});}
}).listen(PORT,'127.0.0.1');

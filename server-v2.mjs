import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile), PORT=31000;
const json=(res,code,obj)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(obj));};
async function sh(cmd,args=[],opts={}){return (await exec(cmd,args,{timeout:opts.timeout||15000,maxBuffer:opts.maxBuffer||12*1024*1024,cwd:opts.cwd,env:opts.env||process.env})).stdout.trim();}
async function psql(q){return sh('/usr/bin/psql',['-U','web_manager','-d','web_manager','-At','-F','\t','-v','ON_ERROR_STOP=1','-c',q]);}
async function privileged(...args){return sh('/usr/bin/sudo',['-n','/usr/local/sbin/web-admin-priv',...args]);}
const esc=s=>String(s).replaceAll("'","''");

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
async function terminal(){
  const out=await sh('/usr/bin/journalctl',['-u','desktop-commander-remote.service','-n','120','--no-pager','-o','short-iso']).catch(e=>String(e.stdout||e.stderr||''));
  return{output:out};
}

const githubHeadCache=new Map();
function githubWebUrl(remote){
  let u=String(remote||'').trim();
  if(u.startsWith('git@github.com:'))u='https://github.com/'+u.slice('git@github.com:'.length);
  if(u.startsWith('ssh://git@github.com/'))u='https://github.com/'+u.slice('ssh://git@github.com/'.length);
  return u.replace(/\.git$/,'');
}
async function githubMainHead(remote){
  if(!remote)return null;
  const cached=githubHeadCache.get(remote); if(cached&&Date.now()-cached.at<60000)return cached.sha;
  try{const out=await sh('/usr/bin/git',['ls-remote',remote,'refs/heads/main'],{timeout:10000});const sha=(out.split(/\s+/)[0]||'').toLowerCase();const val=/^[0-9a-f]{40}$/.test(sha)?sha:null;githubHeadCache.set(remote,{at:Date.now(),sha:val});return val;}catch{githubHeadCache.set(remote,{at:Date.now(),sha:null});return null;}
}
async function gitInfo(repo){
  try{
    const base=['-c',`safe.directory=${repo}`,'-C',repo];
    const [remote,localSha]=await Promise.all([sh('/usr/bin/git',[...base,'remote','get-url','origin']),sh('/usr/bin/git',[...base,'rev-parse','HEAD'])]);
    const githubHead=await githubMainHead(remote);
    return{remote,githubUrl:githubWebUrl(remote),localSha:localSha.toLowerCase(),githubHead};
  }catch{return{remote:null,githubUrl:null,localSha:null,githubHead:null};}
}

async function stats(){
  const mem=(await fs.readFile('/proc/meminfo','utf8')).split('\n').reduce((a,l)=>{const x=l.match(/^(\w+):\s+(\d+)/);if(x)a[x[1]]=+x[2]*1024;return a;},{});
  const load=(await fs.readFile('/proc/loadavg','utf8')).trim().split(/\s+/).slice(0,3).map(Number);
  const d=(await sh('/usr/bin/df',['-B1','--output=size,used,avail,pcent','/'])).split('\n').pop().trim().split(/\s+/);
  const managerDbBytes=+await psql("select pg_database_size('web_manager')");
  const visits=await visitorStats();
  const raw=await psql("select s.id,s.slug,s.name,coalesce(s.port,0),s.status,s.health_status,coalesce(x.hostname,''),s.server_path,coalesce(db.database_name,''),coalesce(s.current_commit,''),coalesce(ld.status,''),coalesce(ld.message,'') from manager.sites s left join lateral(select hostname from manager.site_domains where site_id=s.id and is_primary=true limit 1)x on true left join lateral(select database_name from manager.site_databases where site_id=s.id and status='active' order by created_at limit 1) db on true left join lateral(select status,message from manager.deployments where site_id=s.id order by created_at desc limit 1) ld on true where s.archived_at is null order by s.port");
  const sites=[];
  for(const l of raw.split('\n').filter(Boolean)){
    const [id,slug,name,port,status,health,domain,serverPath,dbName,currentCommit,lastDeployStatus,lastDeployMessage]=l.split('\t');
    let dirBytes=0,dbBytes=0; try{dirBytes=+(await sh('/usr/bin/du',['-sb',serverPath])).split(/\s+/)[0];}catch{}
    if(dbName){try{dbBytes=+await psql(`select pg_database_size('${esc(dbName)}')`);}catch{}}
    else if(slug==='web-admin')dbBytes=managerDbBytes;
    const gi=await gitInfo(serverPath),deployedSha=currentCommit||null;
    let syncStatus='unknown';
    if(deployedSha&&gi.localSha&&gi.localSha!==deployedSha)syncStatus='drift';
    else if(deployedSha&&gi.githubHead===deployedSha)syncStatus='sync';
    else if(deployedSha&&gi.githubHead)syncStatus='behind';
    sites.push({id,slug,name,port:+port,status,health,domain,dirBytes,dbBytes,dbName:dbName||null,githubUrl:gi.githubUrl,githubHead:gi.githubHead,localSha:gi.localSha,deployedSha,syncStatus,lastDeployStatus:lastDeployStatus||null,lastDeployMessage:lastDeployMessage||null,visitors:visits[slug]||[]});
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
  if(existing){[providerId,cred]=existing.split('\t');if(!(cred==='/etc/web-manager/secrets/duckdns.env'||cred.startsWith('/etc/web-manager/secrets/duckdns/')))throw Object.assign(new Error('invalid credential path'),{status:400});}
  else{
    const dupe=await psql(`select id from manager.dns_providers where provider_type='dynamic_dns' and label='${esc(label)}'`);if(dupe)throw Object.assign(new Error('label already exists'),{status:409});
    providerId=randomUUID();cred=`/etc/web-manager/secrets/duckdns/${label}.env`;
  }
  if(domains.length){
    const list=domains.map(d=>`'${esc(d)}'`).join(',');
    const conflict=await psql(`select hostname from manager.dns_provider_domains where provider_id<>'${esc(providerId)}' and hostname in (${list}) limit 1`);
    if(conflict)throw Object.assign(new Error(`domain already belongs to another DuckDNS label: ${conflict}`),{status:409});
  }
  if(apiKey){
    const tmp=`/run/web-admin/duckdns-${randomUUID()}.env`;
    await fs.writeFile(tmp,`DUCKDNS_TOKEN=${apiKey}\n`,{mode:0o600});
    try{await privileged('duckdns-install',cred,tmp);}finally{await fs.unlink(tmp).catch(()=>{});}
  }
  if(!existing)await psql(`insert into manager.dns_providers(id,provider_name,provider_type,credential_ref,status,config,label) values ('${providerId}','duckdns:${esc(label)}','dynamic_dns','${esc(cred)}','active','{"api":"https://www.duckdns.org/update","managed_by":"main_admin_direct"}'::jsonb,'${esc(label)}')`);
  await psql(`begin; update manager.dns_providers set label='${esc(label)}',provider_name=case when provider_name='duckdns' then provider_name else 'duckdns:${esc(label)}' end,updated_at=now() where id='${providerId}'; delete from manager.dns_provider_domains where provider_id='${providerId}'; ${domains.map(d=>`insert into manager.dns_provider_domains(provider_id,hostname) values ('${providerId}','${esc(d)}');`).join(' ')} commit;`);
  return{id:providerId};
}

http.createServer(async(req,res)=>{
  try{
    if(req.method==='GET'&&req.url==='/api/stats')return json(res,200,await stats());
    if(req.method==='GET'&&req.url==='/api/providers')return json(res,200,await providers());
    if(req.method==='GET'&&req.url==='/api/desktop')return json(res,200,await desktop());
    if(req.method==='GET'&&req.url==='/api/terminal')return json(res,200,await terminal());
    if(req.method==='POST'&&req.url==='/api/desktop/start'){await privileged('desktop-start');return json(res,200,{ok:true,...await desktop()});}
    if(req.method==='POST'&&req.url==='/api/desktop/stop'){await privileged('desktop-stop');return json(res,200,{ok:true,service:'inactive'});}
    if(req.method==='POST'&&req.url==='/api/duckdns'){const r=await saveDuckDNS(await body(req));return json(res,200,{ok:true,...r});}
    if(req.method==='GET'&&(req.url==='/'||req.url==='/index.html')){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(await fs.readFile('/srv/sites/web-admin/app/index.html'));}
    res.writeHead(404);res.end();
  }catch(e){json(res,e.status||500,{error:e.message||'server error'});}
}).listen(PORT,'127.0.0.1');

#!/bin/zsh
# Usage: sprite-state.sh <private-dir> <sprite-name>
# Prints the paseo service (pid, started_at, env) and the daemon's /proc/<pid>/environ with PASEO_PASSWORD reduced to
# its length plus an 8-char sha256 prefix (so a change is visible) and every org marker value replaced.
T=$1 N=$2
mask() { sed "s/$(cat $T/markerval)/<org-marker>/g" }
sprite api /v1/sprites/$N/services -- -s 2>/dev/null | node -e '
  const c=require("crypto");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const svc=JSON.parse(s).find(x=>x.name==="paseo");
    if(!svc){console.log("service: none");return}
    const env=Object.entries(svc.env).map(([k,v])=>k==="PASEO_PASSWORD"?`${k}=<${v.length} chars sha256:${c.createHash("sha256").update(v).digest("hex").slice(0,8)}>`:`${k}=${v}`);
    console.log(`service paseo: status=${svc.state.status} pid=${svc.state.pid} started_at=${svc.state.started_at}`);
    console.log(`service env: ${env.join(" ")}`);
    process.stderr.write(String(svc.state.pid));
  })' 2>$T/pid | mask
pid=$(cat $T/pid)
[ -n "$pid" ] && sprite exec -s $N -- sh -c "tr '\0' '\n' < /proc/$pid/environ" 2>&1 | node -e '
  const c=require("crypto");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const l=s.split("\n").filter(Boolean).map(x=>{const [k,...r]=x.split("=");const v=r.join("=");return k==="PASEO_PASSWORD"?`${k}=<${v.length} chars sha256:${c.createHash("sha256").update(v).digest("hex").slice(0,8)}>`:x});
    console.log(`/proc/'$pid'/environ: ${l.join(" ")}`)})' | mask

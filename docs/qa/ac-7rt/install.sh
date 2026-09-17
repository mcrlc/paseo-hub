#!/bin/sh
# Usage: QA_DIR=<private dir> docs/qa/ac-7rt/install.sh <yaml-file>
# Installs/updates one trigger through the public API on localhost (the tunnel is only for the
# sprite's daemon to reach Hub, so no hostname is needed here or in any evidence file).
K=$(cat "$QA_DIR/api-key")
node -e '
const fs=require("fs");
const yaml=fs.readFileSync(process.argv[1],"utf8");
fetch("http://localhost:3000/api/v1/triggers/install",{method:"POST",
  headers:{authorization:"Bearer "+process.argv[2],"content-type":"application/json"},
  body:JSON.stringify({yaml})})
 .then(r=>r.text().then(t=>console.log(r.status,t)));' "$1" "$K"

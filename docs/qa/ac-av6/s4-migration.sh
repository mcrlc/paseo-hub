#!/bin/zsh
# Usage: s4-migration.sh   (run from the repo root of the merged tree; needs docker)
# Fresh database, and a database migrated to 0049 by origin/main before 0050 is applied.
set -eu
ROOT=$PWD
run() { print -- "\$ $*"; "$@" 2>&1 | sed 's/\x1b\[[0-9;]*m//g'; print -- "(exit ${pipestatus[1]})" }
q() { docker exec $1 psql -U postgres -d hub -c "$2" }
print -- "# Scenario 4: migration 0050_organization_sprites_env\n"
print -- "## Journal count"
print -- "origin/main (at merge time): $(git show origin/main:drizzle/meta/_journal.json | grep -c '"tag"')  last: $(git show origin/main:drizzle/meta/_journal.json | grep '"tag"' | tail -1 | tr -d ' ')"
print -- "merged tree:                 $(grep -c '"tag"' drizzle/meta/_journal.json)  last: $(grep '"tag"' drizzle/meta/_journal.json | tail -1 | tr -d ' ')"
print -- "0050 SQL: $(cat drizzle/0050_organization_sprites_env.sql)\n"

print -- "## A. Fresh Postgres"
docker run -d --rm --name acav6-mig-fresh -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=hub -p 55448:5432 postgres:17-alpine >/dev/null
until docker exec acav6-mig-fresh pg_isready -U postgres -d hub >/dev/null 2>&1; do sleep 1; done; sleep 2
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55448/hub run npm run db:migrate
q acav6-mig-fresh '\d organization_sprites_configuration'
q acav6-mig-fresh "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name='organization_sprites_configuration' and column_name='env'"
q acav6-mig-fresh "select count(*) as applied_migrations from drizzle.__drizzle_migrations"
docker rm -f acav6-mig-fresh >/dev/null

print -- "\n## B. Database already at 0049 (migrated by origin/main), with a stored configuration row"
tmp=$(mktemp -d /tmp/acav6-main.XXXX)
git worktree add --detach $tmp origin/main >/dev/null 2>&1
ln -s $ROOT/node_modules $tmp/node_modules
docker run -d --rm --name acav6-mig-0049 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=hub -p 55449:5432 postgres:17-alpine >/dev/null
until docker exec acav6-mig-0049 pg_isready -U postgres -d hub >/dev/null 2>&1; do sleep 1; done; sleep 2
print -- "origin/main worktree at $(git -C $tmp rev-parse --short HEAD)"
(cd $tmp && DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55449/hub run npm run db:migrate)
q acav6-mig-0049 "select count(*) as applied_migrations from drizzle.__drizzle_migrations"
q acav6-mig-0049 "select column_name from information_schema.columns where table_name='organization_sprites_configuration' order by ordinal_position"
q acav6-mig-0049 "insert into organization (id, name, slug) values ('o1','Pre','pre'); insert into organization_sprites_configuration (organization_id, token, memory_mb) values ('o1','pre-existing-token',16384)"
print -- "\nNow the merged tree's migrations:"
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55449/hub run npm run db:migrate
q acav6-mig-0049 "select count(*) as applied_migrations from drizzle.__drizzle_migrations"
q acav6-mig-0049 "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name='organization_sprites_configuration' and column_name='env'"
q acav6-mig-0049 "select organization_id, token, memory_mb, env from organization_sprites_configuration"
print -- "NOT NULL enforced:"
q acav6-mig-0049 "update organization_sprites_configuration set env = null" || true
print -- "Idempotent re-run:"
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55449/hub run npm run db:migrate
q acav6-mig-0049 "select count(*) as applied_migrations from drizzle.__drizzle_migrations"
docker rm -f acav6-mig-0049 >/dev/null
git worktree remove --force $tmp

print -- "\n## npm run db:check"
run npm run db:check
print -- "git status of drizzle/ after db:check: $(git status --short drizzle | wc -l | tr -d ' ') changed files"

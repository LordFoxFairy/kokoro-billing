import type { QueryResultRow } from "pg";
import type { CatalogQuery } from "./schema-database-session.js";
import type { CatalogItem, SchemaCatalog } from "./schema-catalog.types.js";

type ItemRow = QueryResultRow & { key: string; definition: string };
const USER_NAMESPACE =
  "n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'";

async function items(
  client: CatalogQuery,
  sql: string,
): Promise<CatalogItem[]> {
  const result = await client<ItemRow>(sql);
  return result.rows.map(({ key, definition }) => ({ key, definition }));
}

export async function readSchemaCatalog(
  client: CatalogQuery,
): Promise<SchemaCatalog> {
  const version = await client<{ version: string }>(
    "SELECT pg_catalog.current_setting('server_version_num') AS version",
  );
  const database = await items(
    client,
    `
    SELECT 'database' AS key, pg_catalog.jsonb_build_object('encoding',d.encoding,'collate',d.datcollate,'ctype',d.datctype,'provider',COALESCE(pg_catalog.to_jsonb(d)->>'datlocprovider',''),'locale',COALESCE(pg_catalog.to_jsonb(d)->>'datlocale',pg_catalog.to_jsonb(d)->>'daticulocale',''),'rules',COALESCE(pg_catalog.to_jsonb(d)->>'daticurules',''))::pg_catalog.text AS definition
    FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database()`,
  );
  const relations = await items(
    client,
    `
    SELECT n.nspname || '.' || c.relname AS key, pg_catalog.jsonb_build_object('kind',c.relkind,'persistence',c.relpersistence,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity)::pg_catalog.text AS definition
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE ${USER_NAMESPACE} AND c.relkind IN ('r','p','v','m','S','f')
    ORDER BY key
  `,
  );
  const columns = await items(
    client,
    `
    SELECT n.nspname || '.' || c.relname || '.' || a.attnum::pg_catalog.text AS key, pg_catalog.jsonb_build_object('name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',COALESCE(pg_catalog.pg_get_expr(d.adbin,d.adrelid),''),'identity',a.attidentity,'generated',a.attgenerated,'collation',CASE WHEN coll.oid IS NULL THEN '' ELSE cn.nspname||'.'||coll.collname END)::pg_catalog.text AS definition
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace LEFT
    JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT
    JOIN pg_catalog.pg_collation coll ON coll.oid=a.attcollation LEFT
    JOIN pg_catalog.pg_namespace cn ON cn.oid=coll.collnamespace
    WHERE ${USER_NAMESPACE} AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY key
  `,
  );
  const constraints = await items(
    client,
    `
    SELECT n.nspname || '.' || c.relname || '.' || con.conname AS key, pg_catalog.jsonb_build_object('type',con.contype,'definition',pg_catalog.pg_get_constraintdef(con.oid,false),'validated',con.convalidated,'deferrable',con.condeferrable,'deferred',con.condeferred)::pg_catalog.text AS definition
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE ${USER_NAMESPACE} AND con.contype<>'n'
    ORDER BY key
  `,
  );
  const indexes = await items(
    client,
    `
    SELECT n.nspname || '.' || c.relname || '.' || i.relname AS key, pg_catalog.jsonb_build_object('definition',pg_catalog.pg_get_indexdef(ix.indexrelid),'predicate',COALESCE(pg_catalog.pg_get_expr(ix.indpred,ix.indrelid),''),'unique',ix.indisunique,'valid',ix.indisvalid,'ready',ix.indisready,'live',ix.indislive,'nulls_not_distinct',COALESCE(pg_catalog.to_jsonb(ix)->>'indnullsnotdistinct',''))::pg_catalog.text AS definition
    FROM pg_catalog.pg_index ix
    JOIN pg_catalog.pg_class c ON c.oid=ix.indrelid
    JOIN pg_catalog.pg_class i ON i.oid=ix.indexrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE ${USER_NAMESPACE}
    ORDER BY key
  `,
  );
  const types = await items(
    client,
    `
    SELECT n.nspname || '.' || t.typname AS key, pg_catalog.jsonb_build_object('kind',t.typtype,'type',pg_catalog.format_type(t.oid,NULL),'default',COALESCE(pg_catalog.pg_get_expr(t.typdefaultbin,0),t.typdefault,''))::pg_catalog.text AS definition
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace LEFT
    JOIN pg_catalog.pg_class c ON c.oid=t.typrelid LEFT
    JOIN pg_catalog.pg_type base ON base.typarray=t.oid
    WHERE ${USER_NAMESPACE} AND (t.typrelid=0 OR c.relkind='c') AND base.oid IS NULL
    ORDER BY key
  `,
  );
  const routines = await items(
    client,
    `
    SELECT n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS key, pg_catalog.jsonb_build_object('kind',p.prokind,'result',pg_catalog.pg_get_function_result(p.oid),'definition',CASE WHEN p.prokind='a' THEN pg_catalog.jsonb_build_object('source',p.prosrc,'volatility',p.provolatile,'strict',p.proisstrict,'security_definer',p.prosecdef,'parallel',p.proparallel,'config',p.proconfig)::pg_catalog.text ELSE pg_catalog.pg_get_functiondef(p.oid) END)::pg_catalog.text AS definition
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE ${USER_NAMESPACE}
    ORDER BY key
  `,
  );
  const triggers = await items(
    client,
    `
    SELECT n.nspname || '.' || c.relname || '.' || t.tgname AS key, pg_catalog.pg_get_triggerdef(t.oid,false) AS definition
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE ${USER_NAMESPACE} AND NOT t.tgisinternal
    ORDER BY key
  `,
  );
  const rules = await items(
    client,
    `
    SELECT n.nspname || '.' || c.relname || '.' || r.rulename AS key, pg_catalog.pg_get_ruledef(r.oid,false) AS definition
    FROM pg_catalog.pg_rewrite r
    JOIN pg_catalog.pg_class c ON c.oid=r.ev_class
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE ${USER_NAMESPACE}
    ORDER BY key
  `,
  );
  const policies = await items(
    client,
    `
    SELECT n.nspname || '.' || c.relname || '.' || p.polname AS key, pg_catalog.jsonb_build_object('command',p.polcmd,'permissive',p.polpermissive,'using',COALESCE(pg_catalog.pg_get_expr(p.polqual,p.polrelid),''),'check',COALESCE(pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid),''),'roles',ARRAY(SELECT r.rolname
    FROM pg_catalog.pg_roles r WHERE r.oid=ANY(p.polroles) ORDER BY r.rolname))::pg_catalog.text AS definition
    FROM pg_catalog.pg_policy p
    JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE ${USER_NAMESPACE}
    ORDER BY key
  `,
  );
  return {
    serverVersion: version.rows[0]?.version ?? "unknown",
    database,
    relations,
    columns,
    constraints,
    indexes,
    types,
    routines,
    triggers,
    rules,
    policies,
  };
}

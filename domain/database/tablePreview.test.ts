import test from "node:test";
import assert from "node:assert/strict";
import { buildTablePreviewSql } from "./tablePreview.ts";

test("postgres and mysql previews cap rows with limit", () => {
  assert.equal(
    buildTablePreviewSql("postgresql", { schema: "public", name: "users" }, 200),
    "select * from public.users limit 200",
  );
  assert.equal(buildTablePreviewSql("mysql", { name: "users" }, 50), "select * from users limit 50");
});

test("sql server uses top", () => {
  assert.equal(
    buildTablePreviewSql("sqlserver", { schema: "dbo", name: "users" }, 100),
    "select top 100 * from dbo.users",
  );
});

test("oracle and jdbc previews avoid limit syntax", () => {
  assert.equal(buildTablePreviewSql("oracle", { schema: "APP", name: "USERS" }, 100), "select * from APP.USERS");
  assert.equal(
    buildTablePreviewSql("jdbc", { name: "H_BILLOPR_HLJ.BILL_BAK_01" }, 100),
    "select * from H_BILLOPR_HLJ.BILL_BAK_01",
  );
});

test("qualified names are not duplicated when the driver already prefixes the schema", () => {
  assert.equal(
    buildTablePreviewSql("jdbc", { schema: "H_BILLOPR_HLJ", name: "H_BILLOPR_HLJ.BILL_BAK_01" }, 10),
    "select * from H_BILLOPR_HLJ.BILL_BAK_01",
  );
});

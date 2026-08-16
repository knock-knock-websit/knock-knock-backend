import type { Env } from "./types";

export type SevenElevenStore = {
  storeId: string;
  storeName: string;
  storeAddress: string;
  storePhone: string;
};

export async function listSevenElevenStores(request: Request, env: Env) {
  const url = new URL(request.url);
  const search = (url.searchParams.get("search") ?? "").trim().slice(0, 80);
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get("pageSize") ?? "20", 10) || 20));
  const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  const where = search
    ? "provider = 'UNIMART' AND active = 1 AND (store_id LIKE ? ESCAPE '\\' OR store_name LIKE ? ESCAPE '\\' OR store_address LIKE ? ESCAPE '\\')"
    : "provider = 'UNIMART' AND active = 1";
  const values = search ? [pattern, pattern, pattern] : [];
  const [count, stores] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM logistics_stores WHERE ${where}`).bind(...values).first<{ count: number }>(),
    env.DB.prepare(`
      SELECT store_id AS storeId, store_name AS storeName, store_address AS storeAddress, store_phone AS storePhone
      FROM logistics_stores WHERE ${where}
      ORDER BY store_address ASC, store_id ASC LIMIT ? OFFSET ?
    `).bind(...values, pageSize, (page - 1) * pageSize).all<SevenElevenStore>(),
  ]);
  return {
    status: 200,
    body: {
      success: true,
      message: "7-ELEVEN 門市載入成功",
      data: stores.results,
      meta: { page, pageSize, total: Number(count?.count ?? 0) },
    },
  };
}

export async function findSevenElevenStore(env: Env, storeId: string): Promise<SevenElevenStore | null> {
  return env.DB.prepare(`
    SELECT store_id AS storeId, store_name AS storeName, store_address AS storeAddress, store_phone AS storePhone
    FROM logistics_stores WHERE provider = 'UNIMART' AND store_id = ? AND active = 1
  `).bind(storeId).first<SevenElevenStore>();
}

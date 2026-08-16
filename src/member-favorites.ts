import { authenticatedMember } from "./member-auth";
import type { Env, ProductRow } from "./types";

type HandlerResult = { body: unknown; status?: number };

function ok(data: unknown, message: string, status = 200): HandlerResult {
  return { body: { success: true, message, data }, status };
}

function fail(message: string, status: number, code?: string): HandlerResult {
  return { body: { success: false, message, ...(code ? { code } : {}), data: null }, status };
}

const favoriteProductColumns = `
  p.id, p.slug, p.name, p.category, p.description, p.price,
  p.compare_at_price AS compareAtPrice,
  COALESCE(
    (SELECT MIN(variant.price) FROM product_variants variant WHERE variant.product_id = p.id AND variant.purchasable = 1),
    p.price
  ) AS minPrice,
  COALESCE(
    (SELECT MAX(variant.price) FROM product_variants variant WHERE variant.product_id = p.id AND variant.purchasable = 1),
    p.price
  ) AS maxPrice,
  COALESCE(
    (SELECT image.image_url FROM product_images image
      WHERE image.product_id = p.id AND image.active = 1
      ORDER BY image.is_primary DESC, image.sort_order ASC, image.created_at ASC LIMIT 1),
    p.image_url
  ) AS imageUrl,
  '[]' AS imagesJson,
  p.inventory, p.tag_type AS tagType, p.visual, p.tone
`;

function serializeFavorite(row: ProductRow) {
  const { imagesJson: _imagesJson, ...product } = row;
  return { ...product, images: [], isFavorite: true };
}

export async function listMemberFavorites(request: Request, env: Env): Promise<HandlerResult> {
  const member = await authenticatedMember(request, env);
  if (!member) return fail("請先登入會員", 401, "AUTH_REQUIRED");
  const result = await env.DB.prepare(`
    SELECT ${favoriteProductColumns}
    FROM member_favorites favorite
    JOIN products p ON p.id = favorite.product_id
    WHERE favorite.member_id = ? AND p.active = 1
    ORDER BY favorite.created_at DESC
  `).bind(member.id).all<ProductRow>();
  return ok(result.results.map(serializeFavorite), "收藏商品載入成功");
}

export async function createMemberFavorite(request: Request, env: Env): Promise<HandlerResult> {
  const member = await authenticatedMember(request, env);
  if (!member) return fail("請先登入會員", 401, "AUTH_REQUIRED");
  let productId = "";
  try {
    const body = await request.json() as { productId?: unknown };
    productId = typeof body.productId === "string" ? body.productId.trim() : "";
  } catch {
    return fail("商品資料格式不正確", 400);
  }
  if (!productId) return fail("請提供商品編號", 400);
  const product = await env.DB.prepare("SELECT id FROM products WHERE id = ? AND active = 1")
    .bind(productId).first<{ id: string }>();
  if (!product) return fail("找不到可收藏的商品", 404);
  await env.DB.prepare(`
    INSERT OR IGNORE INTO member_favorites (member_id, product_id) VALUES (?, ?)
  `).bind(member.id, productId).run();
  return ok({ productId }, "商品已加入收藏", 201);
}

export async function deleteMemberFavorite(
  request: Request,
  env: Env,
  productId: string,
): Promise<HandlerResult> {
  const member = await authenticatedMember(request, env);
  if (!member) return fail("請先登入會員", 401, "AUTH_REQUIRED");
  await env.DB.prepare("DELETE FROM member_favorites WHERE member_id = ? AND product_id = ?")
    .bind(member.id, productId).run();
  return ok(null, "商品已移除收藏");
}

import type {
  Env,
  ProductDetailRow,
  ProductColorImage,
  ProductImage,
  ProductRow,
  ProductSpecification,
  ProductVariant,
  ProductVariantOptionValue,
} from "./types";
import { handleAdminProducts } from "./admin-products";
import {
  createMemberAddress,
  deleteMemberAddress,
  listMemberAddresses,
  updateMemberAddress,
} from "./member-addresses";
import {
  createMemberFavorite,
  deleteMemberFavorite,
  listMemberFavorites,
} from "./member-favorites";
import {
  authenticatedMember,
  changeMemberPassword,
  getMemberProfile,
  handleMemberAuth,
  memberOverview,
  updateMemberProfile,
} from "./member-auth";
import {
  claimCoupon,
  createPromotionOrder,
  listCoupons,
  listMyCoupons,
  validateUserCoupon,
  validateCode,
} from "./promotions";
import { addMemberCartItem, deleteMemberCartItem, listMemberCart, updateMemberCartItem } from "./member-cart";
import { getShippingSettings, listSevenElevenStores } from "./logistics";
import { getMemberOrder, listMemberOrders, updateMemberOrderRemittance } from "./member-orders";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

function corsHeaders(request: Request, env: Env): HeadersInit {
  const configuredOrigin = env.FRONTEND_ORIGIN?.trim();
  const requestOrigin = request.headers.get("Origin");
  const configuredOrigins = configuredOrigin?.split(",").map((origin) => origin.trim()) ?? [];
  const allowedOrigin = configuredOrigin && configuredOrigin !== "*"
    ? (requestOrigin && configuredOrigins.includes(requestOrigin) ? requestOrigin : "null")
    : "*";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    Vary: "Origin",
  };
}

function respond(request: Request, env: Env, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders, ...corsHeaders(request, env) },
  });
}

const productColumns = `
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
    (
      SELECT pi.image_url
      FROM product_images pi
      WHERE pi.product_id = p.id AND pi.active = 1
      ORDER BY pi.is_primary DESC, pi.sort_order ASC, pi.created_at ASC
      LIMIT 1
    ),
    p.image_url
  ) AS imageUrl,
  COALESCE(
    (
      SELECT json_group_array(json_object(
        'id', image.id,
        'imageUrl', image.image_url,
        'altText', image.alt_text,
        'sortOrder', image.sort_order,
        'isPrimary', image.is_primary
      ))
      FROM (
        SELECT id, image_url, alt_text, sort_order, is_primary
        FROM product_images
        WHERE product_id = p.id AND active = 1
        ORDER BY is_primary DESC, sort_order ASC, created_at ASC
      ) image
    ),
    '[]'
  ) AS imagesJson,
  p.inventory, p.tag_type AS tagType, p.visual, p.tone
`;

function serializeProduct(row: ProductRow, isFavorite = false) {
  const { imagesJson, ...product } = row;
  let images: ProductImage[] = [];
  try {
    const parsed = JSON.parse(imagesJson) as Array<Omit<ProductImage, "isPrimary"> & { isPrimary: number }>;
    images = parsed.map((image) => ({ ...image, isPrimary: Boolean(image.isPrimary) }));
  } catch {
    images = [];
  }
  return { ...product, images, isFavorite };
}

async function favoriteProductIds(request: Request, env: Env, productIds: string[]): Promise<Set<string>> {
  if (!productIds.length) return new Set();
  const member = await authenticatedMember(request, env);
  if (!member) return new Set();
  const placeholders = productIds.map(() => "?").join(", ");
  const result = await env.DB.prepare(`
    SELECT product_id AS productId
    FROM member_favorites
    WHERE member_id = ? AND product_id IN (${placeholders})
  `).bind(member.id, ...productIds).all<{ productId: string }>();
  return new Set(result.results.map((favorite) => favorite.productId));
}

async function serializeProductDetail(env: Env, row: ProductDetailRow, isFavorite = false) {
  type SpecificationRow = Omit<ProductSpecification, "options">;
  type SpecificationOptionRow = {
    id: string;
    specificationId: string;
    name: string;
    sortOrder: number;
  };
  type VariantRow = Omit<ProductVariant, "optionValueIds" | "optionValues" | "purchasable"> & {
    purchasable: number;
  };
  type VariantOptionValueRow = ProductVariantOptionValue & {
    variantId: string;
    sortOrder: number;
  };

  const [specificationResult, optionResult, colorImageResult, variantResult, optionValueResult] = await Promise.all([
    env.DB.prepare(`
      SELECT id, name, sort_order AS sortOrder
      FROM product_specifications
      WHERE product_id = ?
      ORDER BY sort_order ASC, created_at ASC
    `).bind(row.id).all<SpecificationRow>(),
    env.DB.prepare(`
      SELECT option.id, option.specification_id AS specificationId,
        option.name, option.sort_order AS sortOrder
      FROM product_specification_options option
      INNER JOIN product_specifications specification ON specification.id = option.specification_id
      WHERE specification.product_id = ?
      ORDER BY specification.sort_order ASC, option.sort_order ASC, option.created_at ASC
    `).bind(row.id).all<SpecificationOptionRow>(),
    env.DB.prepare(`
      SELECT image.option_id AS optionId, option.name AS optionName, image.image_url AS imageUrl
      FROM product_color_images image
      INNER JOIN product_specification_options option ON option.id = image.option_id
      WHERE image.product_id = ?
      ORDER BY option.sort_order ASC, image.created_at ASC
    `).bind(row.id).all<ProductColorImage>(),
    env.DB.prepare(`
      SELECT id, sku, price, compare_at_price AS compareAtPrice,
        MAX(stock - reserved, 0) AS stock,
        COALESCE((
          SELECT color_image.image_url
          FROM product_color_images color_image
          INNER JOIN product_variant_option_values value
            ON value.option_id = color_image.option_id
          WHERE color_image.product_id = variant.product_id
            AND value.variant_id = variant.id
          LIMIT 1
        ), image_url) AS imageUrl,
        purchasable
      FROM product_variants variant
      WHERE product_id = ? AND purchasable = 1
      ORDER BY sort_order ASC, created_at ASC
    `).bind(row.id).all<VariantRow>(),
    env.DB.prepare(`
      SELECT relation.variant_id AS variantId,
        relation.specification_id AS specificationId,
        specification.name AS specificationName,
        relation.option_id AS optionId,
        option.name AS optionName,
        relation.sort_order AS sortOrder
      FROM product_variant_option_values relation
      INNER JOIN product_variants variant ON variant.id = relation.variant_id
      INNER JOIN product_specifications specification ON specification.id = relation.specification_id
      INNER JOIN product_specification_options option ON option.id = relation.option_id
      WHERE variant.product_id = ? AND variant.purchasable = 1
      ORDER BY relation.variant_id ASC, relation.sort_order ASC
    `).bind(row.id).all<VariantOptionValueRow>(),
  ]);

  const optionsBySpecification = new Map<string, SpecificationOptionRow[]>();
  optionResult.results.forEach((option) => {
    optionsBySpecification.set(option.specificationId, [
      ...(optionsBySpecification.get(option.specificationId) ?? []),
      option,
    ]);
  });
  const valuesByVariant = new Map<string, ProductVariantOptionValue[]>();
  optionValueResult.results.forEach(({ variantId, sortOrder: _sortOrder, ...value }) => {
    valuesByVariant.set(variantId, [...(valuesByVariant.get(variantId) ?? []), value]);
  });
  const specifications = specificationResult.results.map((specification) => ({
    ...specification,
    options: (optionsBySpecification.get(specification.id) ?? []).map(
      ({ specificationId: _specificationId, ...option }) => option,
    ),
  }));
  const variants = variantResult.results.map((variant) => {
    const optionValues = valuesByVariant.get(variant.id) ?? [];
    return {
      ...variant,
      compareAtPrice: variant.compareAtPrice ?? null,
      imageUrl: variant.imageUrl ?? null,
      purchasable: Boolean(variant.purchasable),
      optionValueIds: optionValues.map((value) => value.optionId),
      optionValues,
    };
  });
  return {
    ...serializeProduct(row, isFavorite),
    categoryId: row.categoryId ?? "",
    specificationsEnabled: Boolean(row.specificationsEnabled),
    specifications,
    colorImages: colorImageResult.results,
    variants,
  };
}

async function listProducts(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim().slice(0, 100);
  const category = url.searchParams.get("category")?.trim();
  const categoryId = url.searchParams.get("categoryId")?.trim();
  const tagType = url.searchParams.get("tagType")?.trim();
  const minPriceParam = url.searchParams.get("minPrice");
  const maxPriceParam = url.searchParams.get("maxPrice");
  const minPriceValue = minPriceParam === null || minPriceParam === "" ? Number.NaN : Number(minPriceParam);
  const maxPriceValue = maxPriceParam === null || maxPriceParam === "" ? Number.NaN : Number(maxPriceParam);
  const dateFrom = url.searchParams.get("dateFrom");
  const dateTo = url.searchParams.get("dateTo");
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(48, Math.max(1, Number.parseInt(url.searchParams.get("pageSize") ?? "12", 10) || 12));
  const sort = url.searchParams.get("sort") ?? "popular";
  const conditions = ["p.active = 1"];
  const bindings: Array<string | number> = [];
  let withClause = "";

  if (tagType && !["popular", "preorder", "new", "none"].includes(tagType)) {
    return respond(request, env, { error: "分類標籤篩選格式不正確" }, 400);
  }
  if (!["newest", "oldest", "popular", "price-low", "price-high"].includes(sort)) {
    return respond(request, env, { error: "商品排序格式不正確" }, 400);
  }

  if (search) {
    const keyword = `%${search.toLocaleLowerCase()}%`;
    conditions.push("(LOWER(p.name) LIKE ? OR LOWER(COALESCE(p.code, '')) LIKE ?)");
    bindings.push(keyword, keyword);
  }
  if (categoryId) {
    withClause = `WITH RECURSIVE category_tree(id, name) AS (
      SELECT id, name FROM product_categories WHERE id = ?
      UNION ALL
      SELECT child.id, child.name FROM product_categories child
      JOIN category_tree parent ON child.parent_id = parent.id
    )`;
    bindings.unshift(categoryId);
    conditions.push(`(
      p.category_id IN (SELECT id FROM category_tree)
      OR ((p.category_id IS NULL OR p.category_id = '')
        AND p.category IN (SELECT name FROM category_tree))
    )`);
  } else if (category) {
    conditions.push("p.category = ?");
    bindings.push(category);
  }
  if (tagType) {
    conditions.push("p.tag_type = ?");
    bindings.push(tagType);
  }
  if (Number.isFinite(minPriceValue) && minPriceValue >= 0) {
    conditions.push("p.price >= ?");
    bindings.push(Math.floor(minPriceValue));
  }
  if (Number.isFinite(maxPriceValue) && maxPriceValue >= 0) {
    conditions.push("p.price <= ?");
    bindings.push(Math.floor(maxPriceValue));
  }
  if (dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
    conditions.push("date(p.created_at) >= date(?)");
    bindings.push(dateFrom);
  }
  if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    conditions.push("date(p.created_at) <= date(?)");
    bindings.push(dateTo);
  }

  const orderBy = sort === "price-low"
    ? "p.price ASC, p.sort_order ASC"
    : sort === "price-high"
      ? "p.price DESC, p.sort_order ASC"
      : sort === "newest"
        ? "p.created_at DESC, p.sort_order ASC"
        : sort === "oldest"
          ? "p.created_at ASC, p.sort_order ASC"
      : sort === "popular"
        ? "CASE WHEN p.tag_type = 'popular' THEN 0 ELSE 1 END ASC, p.view_count DESC, p.sort_order ASC"
        : "p.sort_order ASC";
  const whereClause = conditions.join(" AND ");
  const countStatement = env.DB.prepare(`
    ${withClause}
    SELECT COUNT(*) AS total
    FROM products p
    WHERE ${whereClause}
  `);
  const count = await (bindings.length ? countStatement.bind(...bindings) : countStatement)
    .first<{ total: number }>();
  const statement = env.DB.prepare(`
    ${withClause}
    SELECT ${productColumns}
    FROM products p
    WHERE ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `);
  const result = await statement.bind(...bindings, pageSize, (page - 1) * pageSize)
    .all<ProductRow>();
  const favoriteIds = await favoriteProductIds(request, env, result.results.map((product) => product.id));
  const data = result.results.map((product) => serializeProduct(product, favoriteIds.has(product.id)));
  const total = Number(count?.total ?? 0);
  return respond(request, env, {
    success: true,
    message: "操作成功",
    data,
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  });
}

async function listProductCategories(request: Request, env: Env): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT category.id, category.name, category.parent_id AS parentId, category.level,
      category.sort_order AS sortOrder, COUNT(product.id) AS directProductCount
    FROM product_categories category
    LEFT JOIN products product ON (
      product.category_id = category.id OR
      ((product.category_id IS NULL OR product.category_id = '') AND product.category = category.name)
    ) AND product.active = 1
    WHERE category.active = 1
    GROUP BY category.id
    ORDER BY category.level ASC, category.sort_order ASC, category.name ASC
  `).all<{ id: string; name: string; parentId: string | null; level: number; sortOrder: number; directProductCount: number }>();
  type PublicCategory = {
    id: string; name: string; slug: string; parentId: string | null; level: number;
    sortOrder: number; directProductCount: number; productCount: number; children: PublicCategory[];
  };
  const nodes = new Map(result.results.map((category) => [category.id, {
    ...category,
    slug: encodeURIComponent(category.name),
    productCount: Number(category.directProductCount),
    children: [],
  } as PublicCategory]));
  const roots: PublicCategory[] = [];
  for (const category of nodes.values()) {
    const parent = category.parentId ? nodes.get(category.parentId) : undefined;
    if (parent) parent.children.push(category);
    else roots.push(category);
  }
  const sortAndCount = (categories: PublicCategory[]): number => {
    categories.sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, "zh-TW"));
    return categories.reduce((sum, category) => {
      category.productCount = category.directProductCount + sortAndCount(category.children);
      return sum + category.productCount;
    }, 0);
  };
  sortAndCount(roots);
  return respond(request, env, { success: true, message: "操作成功", data: roots });
}

async function listMarquees(request: Request, env: Env): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT id, content, link_url AS linkUrl
    FROM marquees
    WHERE active = 1
    ORDER BY sort_order ASC, created_at DESC
  `).all<{ id: string; content: string; linkUrl: string }>();
  return respond(request, env, {
    success: true,
    message: "操作成功",
    data: result.results,
  });
}

async function listCarousels(request: Request, env: Env): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT id, title, image_url AS imageUrl, description, link_url AS linkUrl
    FROM carousels
    WHERE active = 1
    ORDER BY sort_order ASC, created_at DESC
  `).all<{ id: string; title: string; imageUrl: string; description: string; linkUrl: string }>();
  return respond(request, env, {
    success: true,
    message: "操作成功",
    data: result.results,
  });
}

async function getProduct(request: Request, env: Env, slug: string): Promise<Response> {
  const product = await env.DB.prepare(`
    SELECT ${productColumns},
      p.category_id AS categoryId, p.brand,
      p.seo_title AS seoTitle, p.seo_description AS seoDescription,
      p.specifications_enabled AS specificationsEnabled
    FROM products p
    WHERE p.slug = ? AND p.active = 1
  `).bind(slug).first<ProductDetailRow>();
  if (!product) {
    return respond(request, env, { success: false, message: "找不到商品", data: null }, 404);
  }
  const favoriteIds = await favoriteProductIds(request, env, [product.id]);
  return respond(request, env, {
      success: true,
      message: "操作成功",
      data: await serializeProductDetail(env, product, favoriteIds.has(product.id)),
    });
}

async function listRelatedProducts(
  request: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  const url = new URL(request.url);
  const limitValue = Number(url.searchParams.get("limit") ?? "4");
  if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 12) {
    return respond(request, env, {
      success: false,
      message: "limit 必須是 1 至 12 的整數",
      data: null,
    }, 400);
  }
  const source = await env.DB.prepare(`
    SELECT id, category_id AS categoryId, category, tag_type AS tagType
    FROM products
    WHERE slug = ? AND active = 1
  `).bind(slug).first<{
    id: string;
    categoryId: string | null;
    category: string;
    tagType: ProductRow["tagType"];
  }>();
  if (!source) {
    return respond(request, env, {
      success: false,
      message: "找不到商品",
      data: null,
    }, 404);
  }

  const result = await env.DB.prepare(`
    SELECT ${productColumns}
    FROM products p
    WHERE p.active = 1
      AND p.id <> ?
      AND (p.category_id = ? OR p.category = ?)
    ORDER BY
      CASE WHEN ? <> 'none' AND p.tag_type = ? THEN 0 ELSE 1 END ASC,
      CASE WHEN p.tag_type = 'popular' THEN 0 ELSE 1 END ASC,
      p.sort_order ASC,
      p.created_at DESC
    LIMIT ?
  `).bind(
    source.id,
    source.categoryId,
    source.category,
    source.tagType,
    source.tagType,
    limitValue,
  ).all<ProductRow>();
  const favoriteIds = await favoriteProductIds(request, env, result.results.map((product) => product.id));
  return respond(request, env, {
    success: true,
    message: "操作成功",
    data: result.results.map((product) => serializeProduct(product, favoriteIds.has(product.id))),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    const url = new URL(request.url);
    try {
      await env.DB.prepare(`
        UPDATE products
        SET status = 'active', active = 1, scheduled_publish_at = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE active = 0 AND scheduled_publish_at IS NOT NULL
          AND datetime(scheduled_publish_at) <= CURRENT_TIMESTAMP
      `).run();
      if (request.method === "GET" && url.pathname === "/health") {
        return respond(request, env, { status: "ok", service: "knock-knock-backend" });
      }
      const authResult = await handleMemberAuth(request, env);
      if (authResult) return respond(request, env, authResult.body, authResult.status ?? 200);
      if (request.method === "GET" && url.pathname === "/api/members/overview") {
        const overview = await memberOverview(request, env);
        return respond(request, env, overview.body, overview.status ?? 200);
      }
      if (request.method === "GET" && url.pathname === "/api/members/orders") {
        const orders = await listMemberOrders(request, env);
        return respond(request, env, orders.body, orders.status ?? 200);
      }
      const memberOrderMatch = url.pathname.match(/^\/api\/members\/orders\/([^/]+)$/);
      if (request.method === "GET" && memberOrderMatch?.[1]) {
        const order = await getMemberOrder(request, env, decodeURIComponent(memberOrderMatch[1]));
        return respond(request, env, order.body, order.status ?? 200);
      }
      if (request.method === "PATCH" && memberOrderMatch?.[1]) {
        const order = await updateMemberOrderRemittance(request, env, decodeURIComponent(memberOrderMatch[1]));
        return respond(request, env, order.body, order.status ?? 200);
      }
      if (request.method === "GET" && url.pathname === "/api/members/profile") {
        const profile = await getMemberProfile(request, env);
        return respond(request, env, profile.body, profile.status ?? 200);
      }
      if (request.method === "PUT" && url.pathname === "/api/members/profile") {
        const profile = await updateMemberProfile(request, env);
        return respond(request, env, profile.body, profile.status ?? 200);
      }
      if (request.method === "PUT" && url.pathname === "/api/members/password") {
        const password = await changeMemberPassword(request, env);
        return respond(request, env, password.body, password.status ?? 200);
      }
      if (request.method === "GET" && url.pathname === "/api/members/addresses") {
        const addresses = await listMemberAddresses(request, env);
        return respond(request, env, addresses.body, addresses.status ?? 200);
      }
      if (request.method === "POST" && url.pathname === "/api/members/addresses") {
        const address = await createMemberAddress(request, env);
        return respond(request, env, address.body, address.status ?? 200);
      }
      if (request.method === "GET" && url.pathname === "/api/members/favorites") {
        const favorites = await listMemberFavorites(request, env);
        return respond(request, env, favorites.body, favorites.status ?? 200);
      }
      if (request.method === "GET" && url.pathname === "/api/coupons") {
        const result = await listCoupons(request, env);
        return respond(request, env, result.body, result.status ?? 200);
      }
      const claimMatch = url.pathname.match(/^\/api\/coupons\/([^/]+)\/claim$/);
      if (request.method === "POST" && claimMatch?.[1]) {
        const result = await claimCoupon(request, env, decodeURIComponent(claimMatch[1]));
        return respond(request, env, result.body, result.status ?? 200);
      }
      if (request.method === "GET" && url.pathname === "/api/me/coupons") {
        const result = await listMyCoupons(request, env);
        return respond(request, env, result.body, result.status ?? 200);
      }
      if (request.method === "POST" && url.pathname === "/api/promotions/validate-code") {
        const result = await validateCode(request, env);
        return respond(request, env, result.body, result.status ?? 200);
      }
      if (request.method === "POST" && url.pathname === "/api/promotions/validate-coupon") {
        const result = await validateUserCoupon(request, env);
        return respond(request, env, result.body, result.status ?? 200);
      }
      if (request.method === "GET" && url.pathname === "/api/logistics/711-stores") {
        const result = await listSevenElevenStores(request, env);
        return respond(request, env, result.body, result.status ?? 200);
      }
      if (request.method === "GET" && url.pathname === "/api/logistics/shipping-settings") {
        const result = await getShippingSettings(env);
        return respond(request, env, result.body, result.status);
      }
      if (request.method === "GET" && url.pathname === "/api/members/cart") {
        const cart = await listMemberCart(request, env);
        return respond(request, env, cart.body, cart.status ?? 200);
      }
      if (request.method === "POST" && url.pathname === "/api/members/cart") {
        const cart = await addMemberCartItem(request, env);
        return respond(request, env, cart.body, cart.status ?? 200);
      }
      const memberCartMatch = url.pathname.match(/^\/api\/members\/cart\/([^/]+)$/);
      if (memberCartMatch?.[1]) {
        const id = decodeURIComponent(memberCartMatch[1]);
        if (request.method === "PATCH" || request.method === "PUT") {
          const cart = await updateMemberCartItem(request, env, id);
          return respond(request, env, cart.body, cart.status ?? 200);
        }
        if (request.method === "DELETE") {
          const cart = await deleteMemberCartItem(request, env, id);
          return respond(request, env, cart.body, cart.status ?? 200);
        }
      }
      if (request.method === "POST" && url.pathname === "/api/members/favorites") {
        const favorite = await createMemberFavorite(request, env);
        return respond(request, env, favorite.body, favorite.status ?? 200);
      }
      const memberFavoriteMatch = url.pathname.match(/^\/api\/members\/favorites\/([^/]+)$/);
      if (memberFavoriteMatch?.[1] && request.method === "DELETE") {
        const favorite = await deleteMemberFavorite(request, env, decodeURIComponent(memberFavoriteMatch[1]));
        return respond(request, env, favorite.body, favorite.status ?? 200);
      }
      const memberAddressMatch = url.pathname.match(/^\/api\/members\/addresses\/([^/]+)$/);
      if (memberAddressMatch?.[1]) {
        const id = decodeURIComponent(memberAddressMatch[1]);
        if (request.method === "PUT") {
          const address = await updateMemberAddress(request, env, id);
          return respond(request, env, address.body, address.status ?? 200);
        }
        if (request.method === "DELETE") {
          const address = await deleteMemberAddress(request, env, id);
          return respond(request, env, address.body, address.status ?? 200);
        }
      }
      if (url.pathname.startsWith("/api/admin/")) {
        if (env.ADMIN_API_TOKEN && request.headers.get("Authorization") !== `Bearer ${env.ADMIN_API_TOKEN}`) {
          return respond(request, env, { success: false, message: "未授權", data: null }, 401);
        }
        const result = await handleAdminProducts(request, env);
        if (result) return respond(request, env, result.body, result.status ?? 200);
      }
      if (request.method === "GET" && url.pathname === "/api/products") return listProducts(request, env);
      if (request.method === "GET" && url.pathname === "/api/product-categories") return listProductCategories(request, env);
      if (request.method === "GET" && url.pathname === "/api/marquees") return listMarquees(request, env);
      if (request.method === "GET" && url.pathname === "/api/carousels") return listCarousels(request, env);
      const relatedProductMatch = url.pathname.match(/^\/api\/products\/([^/]+)\/related$/);
      if (request.method === "GET" && relatedProductMatch?.[1]) {
        return listRelatedProducts(request, env, decodeURIComponent(relatedProductMatch[1]));
      }
      const productViewMatch = url.pathname.match(/^\/api\/products\/([^/]+)\/view$/);
      if (request.method === "POST" && productViewMatch?.[1]) {
        const slug = decodeURIComponent(productViewMatch[1]);
        const result = await env.DB.prepare(`
          UPDATE products
          SET view_count = view_count + 1
          WHERE slug = ? AND active = 1
        `).bind(slug).run();
        return result.meta.changes
          ? respond(request, env, { success: true, message: "瀏覽數已更新", data: null })
          : respond(request, env, { success: false, message: "找不到商品", data: null }, 404);
      }
      const productMatch = url.pathname.match(/^\/api\/products\/([^/]+)$/);
      if (request.method === "GET" && productMatch?.[1]) {
        return getProduct(request, env, decodeURIComponent(productMatch[1]));
      }
      if (request.method === "POST" && url.pathname === "/api/orders") {
        const result = await createPromotionOrder(request, env);
        return respond(request, env, result.body, result.status ?? 200);
      }
      return respond(request, env, { error: "找不到路由" }, 404);
    } catch (error) {
      console.error(error);
      return respond(request, env, { error: "伺服器暫時無法處理請求" }, 500);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await env.DB.prepare(`
      UPDATE products
      SET status = 'active', active = 1, scheduled_publish_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE active = 0 AND scheduled_publish_at IS NOT NULL
        AND datetime(scheduled_publish_at) <= CURRENT_TIMESTAMP
    `).run();
  },
} satisfies ExportedHandler<Env>;

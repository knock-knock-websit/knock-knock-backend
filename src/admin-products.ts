import type { Env } from "./types";

type ApiResult = { body: unknown; status?: number };

type ProductImageInput = {
  id: string;
  imageUrl: string;
  altText: string;
  sortOrder: number;
  isPrimary: boolean;
};
type ProductColorImageInput = { optionId: string; optionName: string; imageUrl: string };

type SpecificationOptionInput = { id: string; name: string; sortOrder: number };
type SpecificationInput = {
  id: string;
  name: string;
  sortOrder: number;
  options: SpecificationOptionInput[];
};
type VariantOptionValueInput = {
  specificationId: string;
  specificationName: string;
  optionId: string;
  optionName: string;
};
type VariantInput = {
  id: string;
  sku: string;
  optionValueIds: string[];
  optionValues: VariantOptionValueInput[];
  price: number;
  compareAtPrice: number | null;
  stock: number;
  safetyStock: number;
  reserved: number;
  imageUrl: string | null;
  purchasable: boolean;
};
type AdminProductInput = {
  name: string;
  code: string;
  category: string;
  categoryId?: string | null;
  description: string;
  status: "active" | "inactive";
  tagType: "popular" | "preorder" | "new" | "none";
  price: number;
  compareAtPrice: number | null;
  cost: number;
  safetyStock: number;
  brand: string;
  seoTitle: string;
  seoDescription: string;
  sortOrder: number;
  images: ProductImageInput[];
  colorImages?: ProductColorImageInput[];
  specificationsEnabled: boolean;
  specifications: SpecificationInput[];
  variants: VariantInput[];
};

type AdminProductRow = {
  id: string;
  name: string;
  code: string;
  category: string;
  categoryId: string | null;
  description: string;
  price: number;
  compareAtPrice: number | null;
  cost: number;
  inventory: number;
  safetyStock: number;
  status: "active" | "inactive" | "draft";
  tagType: "popular" | "preorder" | "new" | "none";
  brand: string;
  seoTitle: string;
  seoDescription: string;
  sortOrder: number;
  specificationsEnabled: number;
  createdAt: string;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isNonNegativeNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isNonNegativeInteger = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

function validateProductInput(value: unknown): string | null {
  if (!isObject(value)) return "商品資料格式不正確";
  for (const field of ["name", "code", "category", "description", "brand"] as const) {
    if (typeof value[field] !== "string" || !String(value[field]).trim()) return `${field} 為必填欄位`;
  }
  if (value.status !== "active" && value.status !== "inactive") return "商品狀態不正確";
  if (value.tagType !== "popular" && value.tagType !== "preorder" &&
      value.tagType !== "new" && value.tagType !== "none") {
    return "標籤分類為必填欄位";
  }
  if (!Array.isArray(value.images) || !value.images.length) return "至少需要一張商品圖片";
  if (!Array.isArray(value.variants) || !value.variants.length) return "至少需要一個 SKU";
  if (!Array.isArray(value.specifications)) return "商品規格格式不正確";
  if (typeof value.specificationsEnabled !== "boolean") return "商品規格狀態不正確";

  const specificationNames = new Set<string>();
  const specificationIds = new Set<string>();
  const optionIds = new Set<string>();
  for (const rawSpecification of value.specifications) {
    if (!isObject(rawSpecification) || typeof rawSpecification.id !== "string" ||
      typeof rawSpecification.name !== "string" || !rawSpecification.name.trim() ||
      !Array.isArray(rawSpecification.options) || !rawSpecification.options.length) {
      return "規格名稱與選項為必填";
    }
    const nameKey = rawSpecification.name.trim().toLocaleLowerCase();
    if (specificationNames.has(nameKey)) return "規格名稱不可重複";
    specificationNames.add(nameKey);
    if (specificationIds.has(rawSpecification.id)) return "規格 ID 不可重複";
    specificationIds.add(rawSpecification.id);
    const names = new Set<string>();
    for (const rawOption of rawSpecification.options) {
      if (!isObject(rawOption) || typeof rawOption.id !== "string" ||
        typeof rawOption.name !== "string" || !rawOption.name.trim()) return "規格選項為必填";
      const optionNameKey = rawOption.name.trim().toLocaleLowerCase();
      if (names.has(optionNameKey)) return "同一規格的選項不可重複";
      names.add(optionNameKey);
      if (optionIds.has(rawOption.id)) return "規格選項 ID 不可重複";
      optionIds.add(rawOption.id);
    }
  }
  if (value.specificationsEnabled && !value.specifications.length) return "啟用規格時至少需要一組規格";

  const skuCodes = new Set<string>();
  const signatures = new Set<string>();
  for (const rawVariant of value.variants) {
    if (!isObject(rawVariant) || typeof rawVariant.id !== "string" ||
      typeof rawVariant.sku !== "string" || !rawVariant.sku.trim() ||
      !Array.isArray(rawVariant.optionValueIds) || !Array.isArray(rawVariant.optionValues)) {
      return "SKU 資料格式不正確";
    }
    const skuKey = rawVariant.sku.trim().toLocaleUpperCase();
    if (skuCodes.has(skuKey)) return "SKU 編號不可重複";
    skuCodes.add(skuKey);
    const signature = rawVariant.optionValueIds.join("|");
    if (signatures.has(signature)) return "SKU 規格組合不可重複";
    signatures.add(signature);
    if (!isNonNegativeNumber(rawVariant.price) ||
      (rawVariant.compareAtPrice !== null && !isNonNegativeNumber(rawVariant.compareAtPrice)) ||
      !isNonNegativeInteger(rawVariant.stock) || !isNonNegativeInteger(rawVariant.safetyStock) ||
      !isNonNegativeInteger(rawVariant.reserved) || Number(rawVariant.reserved) > Number(rawVariant.stock)) {
      return "SKU 價格或庫存格式不正確";
    }
    if (rawVariant.optionValueIds.some((id) => typeof id !== "string" || !optionIds.has(id))) {
      return "SKU 包含不存在的規格選項";
    }
  }
  if (value.colorImages !== undefined && !Array.isArray(value.colorImages)) {
    return "顏色圖片格式不正確";
  }
  if (Array.isArray(value.colorImages)) {
    const usedOptionIds = new Set<string>();
    for (const rawImage of value.colorImages) {
      if (!isObject(rawImage) || typeof rawImage.optionId !== "string" ||
        !optionIds.has(rawImage.optionId) || usedOptionIds.has(rawImage.optionId) ||
        typeof rawImage.imageUrl !== "string" || !rawImage.imageUrl.trim()) {
        return "顏色圖片必須對應不重複的規格選項";
      }
      usedOptionIds.add(rawImage.optionId);
    }
  }
  return null;
}

function synchronizeVariantImagesByColor(input: AdminProductInput): AdminProductInput & { colorImages: ProductColorImageInput[] } {
  const imageByColorOptionId = new Map<string, string>();
  const colorNames = new Set(["顏色", "颜色", "color"]);

  input.colorImages?.forEach((image) => imageByColorOptionId.set(image.optionId, image.imageUrl));

  input.variants.forEach((variant) => {
    const colorOption = variant.optionValues.find((value) =>
      colorNames.has(value.specificationName.trim().toLocaleLowerCase()),
    );
    if (colorOption && variant.imageUrl && !imageByColorOptionId.has(colorOption.optionId)) {
      imageByColorOptionId.set(colorOption.optionId, variant.imageUrl);
    }
  });

  return {
    ...input,
    colorImages: [...imageByColorOptionId].map(([optionId, imageUrl]) => {
      const option = input.variants.flatMap((variant) => variant.optionValues)
        .find((value) => value.optionId === optionId);
      return { optionId, optionName: option?.optionName ?? "", imageUrl };
    }),
    variants: input.variants.map((variant) => {
      const colorOption = variant.optionValues.find((value) =>
        colorNames.has(value.specificationName.trim().toLocaleLowerCase()),
      );
      return colorOption
        ? { ...variant, imageUrl: imageByColorOptionId.get(colorOption.optionId) ?? null }
        : variant;
    }),
  };
}

const productSelect = `
  SELECT
    id, name, COALESCE(code, upper(slug)) AS code, category,
    category_id AS categoryId, description, price,
    compare_at_price AS compareAtPrice, cost, inventory,
    safety_stock AS safetyStock, status, tag_type AS tagType, brand,
    seo_title AS seoTitle, seo_description AS seoDescription,
    sort_order AS sortOrder,
    specifications_enabled AS specificationsEnabled,
    created_at AS createdAt
  FROM products
`;

async function hydrateProduct(env: Env, row: AdminProductRow) {
  const [imageResult, specificationResult, optionResult, colorImageResult, variantResult, valueResult] = await Promise.all([
    env.DB.prepare(`SELECT id, image_url AS imageUrl, alt_text AS altText, sort_order AS sortOrder,
      is_primary AS isPrimary FROM product_images WHERE product_id = ? AND active = 1
      ORDER BY is_primary DESC, sort_order ASC`).bind(row.id).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT id, name, sort_order AS sortOrder FROM product_specifications
      WHERE product_id = ? ORDER BY sort_order ASC`).bind(row.id).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT option.id, option.specification_id AS specificationId, option.name,
      option.sort_order AS sortOrder FROM product_specification_options option
      JOIN product_specifications specification ON specification.id = option.specification_id
      WHERE specification.product_id = ? ORDER BY specification.sort_order, option.sort_order`)
      .bind(row.id).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT image.option_id AS optionId, option.name AS optionName,
      image.image_url AS imageUrl FROM product_color_images image
      JOIN product_specification_options option ON option.id = image.option_id
      WHERE image.product_id = ? ORDER BY option.sort_order, image.created_at`)
      .bind(row.id).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT id, sku, price, compare_at_price AS compareAtPrice, stock,
      safety_stock AS safetyStock, reserved, image_url AS imageUrl,
      purchasable, sort_order AS sortOrder FROM product_variants
      WHERE product_id = ? ORDER BY sort_order ASC`).bind(row.id).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT value.variant_id AS variantId, value.specification_id AS specificationId,
      specification.name AS specificationName, value.option_id AS optionId, option.name AS optionName,
      value.sort_order AS sortOrder FROM product_variant_option_values value
      JOIN product_specifications specification ON specification.id = value.specification_id
      JOIN product_specification_options option ON option.id = value.option_id
      JOIN product_variants variant ON variant.id = value.variant_id
      WHERE variant.product_id = ? ORDER BY value.variant_id, value.sort_order`)
      .bind(row.id).all<Record<string, unknown>>(),
  ]);
  const optionsBySpecification = new Map<string, Record<string, unknown>[]>();
  for (const option of optionResult.results) {
    const key = String(option.specificationId);
    optionsBySpecification.set(key, [...(optionsBySpecification.get(key) ?? []), option]);
  }
  const valuesByVariant = new Map<string, Record<string, unknown>[]>();
  for (const optionValue of valueResult.results) {
    const key = String(optionValue.variantId);
    valuesByVariant.set(key, [...(valuesByVariant.get(key) ?? []), optionValue]);
  }
  const images = imageResult.results.map((image) => ({
    id: String(image.id),
    imageUrl: String(image.imageUrl),
    altText: String(image.altText ?? ""),
    sortOrder: Number(image.sortOrder),
    isPrimary: Boolean(image.isPrimary),
  }));
  const variants = variantResult.results.map((variant) => {
    const optionValues = (valuesByVariant.get(String(variant.id)) ?? []).map(({ variantId: _variantId, sortOrder: _sortOrder, ...value }) => value);
    const colorImage = colorImageResult.results.find((image) =>
      optionValues.some((value) => value.optionId === image.optionId),
    );
    return {
      ...variant,
      compareAtPrice: variant.compareAtPrice ?? null,
      imageUrl: colorImage?.imageUrl ?? variant.imageUrl ?? null,
      purchasable: Boolean(variant.purchasable),
      optionValueIds: optionValues.map((value) => String(value.optionId)),
      optionValues,
    };
  });
  return {
    ...row,
    categoryId: row.categoryId ?? "",
    specificationsEnabled: Boolean(row.specificationsEnabled),
    images,
    colorImages: colorImageResult.results,
    image: String((images.find((image) => image.isPrimary) ?? images[0])?.imageUrl ?? ""),
    specifications: specificationResult.results.map((specification) => ({
      ...specification,
      options: optionsBySpecification.get(String(specification.id)) ?? [],
    })),
    variants,
  };
}

async function listAdminProducts(request: Request, env: Env): Promise<ApiResult> {
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim().slice(0, 100);
  const status = url.searchParams.get("status");
  const tagType = url.searchParams.get("tagType")?.trim();
  const categoryId = url.searchParams.get("categoryId")?.trim();
  const dateFrom = url.searchParams.get("dateFrom");
  const dateTo = url.searchParams.get("dateTo");
  const conditions: string[] = [];
  const bindings: Array<string | number> = [];

  if (tagType && !["popular", "preorder", "new", "none"].includes(tagType)) {
    return { body: { success: false, message: "分類標籤篩選格式不正確", data: null }, status: 400 };
  }

  if (search) {
    const keyword = `%${search.toLocaleLowerCase()}%`;
    conditions.push("(LOWER(name) LIKE ? OR LOWER(COALESCE(code, '')) LIKE ?)");
    bindings.push(keyword, keyword);
  }
  if (status && ["active", "inactive", "draft"].includes(status)) {
    conditions.push("status = ?");
    bindings.push(status);
  }
  if (tagType) {
    conditions.push("tag_type = ?");
    bindings.push(tagType);
    if (tagType !== "none") conditions.push("status = 'active'");
  }
  if (categoryId) {
    conditions.push(`category_id IN (
      WITH RECURSIVE category_tree(id) AS (
        SELECT id FROM product_categories WHERE id = ?
        UNION ALL
        SELECT child.id FROM product_categories child
        JOIN category_tree parent ON child.parent_id = parent.id
      )
      SELECT id FROM category_tree
    )`);
    bindings.push(categoryId);
  }
  if (dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
    conditions.push("date(created_at) >= date(?)");
    bindings.push(dateFrom);
  }
  if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    conditions.push("date(created_at) <= date(?)");
    bindings.push(dateTo);
  }

  const whereClause = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const statement = env.DB.prepare(
    `${productSelect}${whereClause} ORDER BY created_at DESC, sort_order ASC`,
  );
  const result = await (bindings.length ? statement.bind(...bindings) : statement)
    .all<AdminProductRow>();
  const data = await Promise.all(result.results.map((row) => hydrateProduct(env, row)));
  return {
    body: {
      success: true,
      message: "操作成功",
      data,
      pagination: { page: 1, pageSize: data.length, total: data.length },
    },
  };
}

function relationStatements(env: Env, productId: string, input: AdminProductInput) {
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM product_variant_option_values WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = ?)").bind(productId),
    env.DB.prepare("DELETE FROM product_variants WHERE product_id = ?").bind(productId),
    env.DB.prepare("DELETE FROM product_color_images WHERE product_id = ?").bind(productId),
    env.DB.prepare("DELETE FROM product_specification_options WHERE specification_id IN (SELECT id FROM product_specifications WHERE product_id = ?)").bind(productId),
    env.DB.prepare("DELETE FROM product_specifications WHERE product_id = ?").bind(productId),
    env.DB.prepare("DELETE FROM product_images WHERE product_id = ?").bind(productId),
  ];
  input.images.forEach((image, index) => statements.push(env.DB.prepare(`
    INSERT INTO product_images (id, product_id, image_url, alt_text, sort_order, is_primary, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).bind(image.id, productId, image.imageUrl, image.altText, index, image.isPrimary ? 1 : 0)));
  if (input.specificationsEnabled) {
    input.specifications.forEach((specification, specificationIndex) => {
      statements.push(env.DB.prepare(`INSERT INTO product_specifications
        (id, product_id, name, sort_order) VALUES (?, ?, ?, ?)`)
        .bind(specification.id, productId, specification.name.trim(), specificationIndex));
      specification.options.forEach((option, optionIndex) => statements.push(env.DB.prepare(`
        INSERT INTO product_specification_options (id, specification_id, name, sort_order)
        VALUES (?, ?, ?, ?)
      `).bind(option.id, specification.id, option.name.trim(), optionIndex)));
    });
    (input.colorImages ?? []).forEach((image) => statements.push(env.DB.prepare(`
      INSERT INTO product_color_images (id, product_id, option_id, image_url)
      VALUES (?, ?, ?, ?)
    `).bind(`color_image_${crypto.randomUUID()}`, productId, image.optionId, image.imageUrl)));
  }
  input.variants.forEach((variant, variantIndex) => {
    const color = variant.optionValues.find((value) => value.specificationName === "顏色")?.optionName ?? "";
    const size = variant.optionValues.find((value) => value.specificationName === "尺寸")?.optionName ?? "";
    statements.push(env.DB.prepare(`INSERT INTO product_variants
      (id, product_id, sku, color, size, price, compare_at_price, stock, safety_stock,
       reserved, image_url, purchasable, option_signature, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(variant.id, productId, variant.sku.trim(), color, size, variant.price,
        variant.compareAtPrice, variant.stock, variant.safetyStock, variant.reserved,
        variant.optionValues.some((value) =>
          (input.colorImages ?? []).some((image) => image.optionId === value.optionId)
        ) ? null : variant.imageUrl,
        variant.purchasable ? 1 : 0, variant.optionValueIds.join("|"), variantIndex));
    if (input.specificationsEnabled) {
      variant.optionValues.forEach((value, optionIndex) => statements.push(env.DB.prepare(`
        INSERT INTO product_variant_option_values
          (variant_id, specification_id, option_id, sort_order) VALUES (?, ?, ?, ?)
      `).bind(variant.id, value.specificationId, value.optionId, optionIndex)));
    }
  });
  return statements;
}

const slugify = (name: string, id: string) => {
  const slug = name.trim().toLocaleLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "");
  return `${slug || "product"}-${id.slice(0, 8)}`;
};

async function saveAdminProduct(request: Request, env: Env, id?: string): Promise<ApiResult> {
  let payload: unknown;
  try { payload = await request.json(); } catch { return { body: { success: false, message: "JSON 格式不正確", data: null }, status: 400 }; }
  const validationError = validateProductInput(payload);
  if (validationError) return { body: { success: false, message: validationError, data: null }, status: 422 };
  const input = synchronizeVariantImagesByColor(payload as AdminProductInput);
  const productId = id ?? crypto.randomUUID();
  const primaryImage = input.images.find((image) => image.isPrimary)?.imageUrl ?? input.images[0]?.imageUrl ?? null;
  const inventory = input.variants.reduce((sum, variant) => sum + variant.stock, 0);
  const price = Math.min(...input.variants.map((variant) => variant.price));
  const compareAtPrices = input.variants
    .map((variant) => variant.compareAtPrice)
    .filter((value): value is number => value !== null);
  const compareAtPrice = compareAtPrices.length ? Math.max(price, Math.min(...compareAtPrices)) : null;
  const safetyStock = Math.min(...input.variants.map((variant) => variant.safetyStock));
  const baseStatement = id
    ? env.DB.prepare(`UPDATE products SET name = ?, code = ?, category = ?, category_id = ?,
        description = ?, price = ?, compare_at_price = ?, cost = ?, inventory = ?, safety_stock = ?,
        status = ?, tag_type = ?, active = ?, brand = ?, seo_title = ?, seo_description = ?,
        sort_order = ?, image_url = ?, specifications_enabled = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`)
      .bind(input.name.trim(), input.code.trim(), input.category, input.categoryId ?? null,
        input.description, price, compareAtPrice, input.cost, inventory, safetyStock,
        input.status, input.tagType, input.status === "active" ? 1 : 0, input.brand, input.seoTitle,
        input.seoDescription, input.sortOrder, primaryImage,
        input.specificationsEnabled ? 1 : 0, productId)
    : env.DB.prepare(`INSERT INTO products
        (id, slug, name, code, category, category_id, description, price, compare_at_price,
         cost, inventory, safety_stock, status, tag_type, active, brand, seo_title, seo_description,
         sort_order, image_url, specifications_enabled, visual, tone)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'image', 'neutral')`)
      .bind(productId, slugify(input.name, productId), input.name.trim(), input.code.trim(),
        input.category, input.categoryId ?? null, input.description, price, compareAtPrice,
        input.cost, inventory, safetyStock, input.status, input.tagType, input.status === "active" ? 1 : 0,
        input.brand, input.seoTitle, input.seoDescription, input.sortOrder,
        primaryImage, input.specificationsEnabled ? 1 : 0);
  await env.DB.batch([baseStatement, ...relationStatements(env, productId, input)]);
  const row = await env.DB.prepare(`${productSelect} WHERE id = ?`).bind(productId).first<AdminProductRow>();
  return row
    ? { body: { success: true, message: id ? "商品已更新" : "商品已建立", data: await hydrateProduct(env, row) }, status: id ? 200 : 201 }
    : { body: { success: false, message: "商品儲存失敗", data: null }, status: 500 };
}

async function deleteAdminProduct(env: Env, id: string): Promise<ApiResult> {
  const result = await env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
  return result.meta.changes
    ? { body: { success: true, message: "商品已刪除", data: null } }
    : { body: { success: false, message: "找不到商品", data: null }, status: 404 };
}

async function uploadImage(request: Request, env: Env): Promise<ApiResult> {
  if (!env.PRODUCT_IMAGES || !env.PRODUCT_IMAGES_PUBLIC_URL) {
    return { body: { success: false, message: "尚未設定商品圖片儲存空間", data: null }, status: 503 };
  }
  const formData = await request.formData();
  const file = formData.get("file");
  if (!file || typeof file === "string") return { body: { success: false, message: "請選擇圖片", data: null }, status: 400 };
  const uploadedFile = file as File;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(uploadedFile.type) || uploadedFile.size > 5 * 1024 * 1024) {
    return { body: { success: false, message: "圖片僅支援 JPG、PNG、WebP 且不可超過 5MB", data: null }, status: 422 };
  }
  const extension = uploadedFile.type === 'image/png' ? 'png' : uploadedFile.type === 'image/webp' ? 'webp' : 'jpg';
  const key = `products/${crypto.randomUUID()}.${extension}`;
  await env.PRODUCT_IMAGES.put(key, uploadedFile.stream(), { httpMetadata: { contentType: uploadedFile.type } });
  const imageUrl = `${env.PRODUCT_IMAGES_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
  return { body: { success: true, message: "圖片已上傳", data: { imageUrl } }, status: 201 };
}

export async function handleAdminProducts(request: Request, env: Env): Promise<ApiResult | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/admin/uploads/products" && request.method === "POST") return uploadImage(request, env);
  if (url.pathname === "/api/admin/products" && request.method === "GET") return listAdminProducts(request, env);
  if (url.pathname === "/api/admin/products" && request.method === "POST") return saveAdminProduct(request, env);
  if (url.pathname.startsWith("/api/admin/products/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/admin/products/".length));
    if (request.method === "PUT") return saveAdminProduct(request, env, id);
    if (request.method === "DELETE") return deleteAdminProduct(env, id);
  }
  return null;
}

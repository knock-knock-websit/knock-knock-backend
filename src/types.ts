export type Env = {
  DB: D1Database;
  FRONTEND_ORIGIN?: string;
  ADMIN_API_TOKEN?: string;
  AUTH_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  ENVIRONMENT?: string;
  PRODUCT_IMAGES?: R2Bucket;
  PRODUCT_IMAGES_PUBLIC_URL?: string;
};

export type ProductRow = {
  id: string;
  slug: string;
  name: string;
  category: string;
  description: string;
  price: number;
  compareAtPrice: number | null;
  minPrice: number;
  maxPrice: number;
  imageUrl: string | null;
  imagesJson: string;
  inventory: number;
  tagType: "popular" | "preorder" | "new" | "none";
  visual: string;
  tone: string;
};

export type ProductImage = {
  id: string;
  imageUrl: string;
  altText: string;
  sortOrder: number;
  isPrimary: boolean;
};

export type ProductColorImage = {
  optionId: string;
  optionName: string;
  imageUrl: string;
};

export type ProductSpecificationOption = {
  id: string;
  name: string;
  sortOrder: number;
};

export type ProductSpecification = {
  id: string;
  name: string;
  sortOrder: number;
  options: ProductSpecificationOption[];
};

export type ProductVariantOptionValue = {
  specificationId: string;
  specificationName: string;
  optionId: string;
  optionName: string;
};

export type ProductVariant = {
  id: string;
  sku: string;
  optionValueIds: string[];
  optionValues: ProductVariantOptionValue[];
  price: number;
  compareAtPrice: number | null;
  stock: number;
  imageUrl: string | null;
  purchasable: boolean;
};

export type ProductDetailRow = ProductRow & {
  categoryId: string | null;
  brand: string;
  seoTitle: string;
  seoDescription: string;
  specificationsEnabled: number;
};

export type OrderItemInput = {
  productId: string;
  variantId?: string;
  quantity: number;
};

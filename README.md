# KNOCK-KNOCK Backend

獨立的 Cloudflare Worker REST API，透過 `DB` binding 存取 D1，不包含任何前台程式碼或資料庫遷移。

## API

- `GET /health`
- `GET /api/products`
- `GET /api/products?search=小卡&categoryId=cat_photocards&minPrice=300&maxPrice=1000&sort=price-low&page=1&pageSize=12`
- `GET /api/products/:slug`
- `GET /api/product-categories`
- `POST /api/auth/register`，body：`{"name":"王小明","email":"member@example.com","password":"..."}`
- `POST /api/auth/verify-email`，body：`{"email":"member@example.com","code":"123456"}`
- `POST /api/auth/resend-verification`，body：`{"email":"member@example.com"}`
- `POST /api/auth/login`，body：`{"email":"member@example.com","password":"..."}`
- `POST /api/auth/logout`，使用會員 Bearer token
- `POST /api/auth/request-password-reset`，body：`{"email":"member@example.com"}`，寄送 30 分鐘有效的一次性重設網址
- `POST /api/auth/reset-password`，body：`{"token":"...","password":"..."}`
- `GET /api/members/overview`，需要會員 Bearer token，回傳 `orderCount`、`favoriteCount`、`availableCouponCount`
- `GET /api/members/favorites`，需要會員 Bearer token，回傳會員收藏商品
- `POST /api/members/favorites`，需要會員 Bearer token，以 `{ "productId": "..." }` 新增收藏
- `DELETE /api/members/favorites/:productId`，需要會員 Bearer token，移除收藏
- `GET /api/members/profile`，需要會員 Bearer token，回傳姓名、唯讀 Email、生日與性別
- `PUT /api/members/profile`，需要會員 Bearer token，body：`{"name":"王小明","birthday":"1995-08-10","gender":"undisclosed|female|male|other"}`；Email 不可修改
- `PUT /api/members/password`，需要會員 Bearer token，body：`{"currentPassword":"...","newPassword":"...","confirmPassword":"..."}`
- `GET /api/members/addresses`，需要會員 Bearer token，取得會員常用超商門市列表
- `POST /api/members/addresses`，需要會員 Bearer token，新增常用超商門市
- `PUT /api/members/addresses/:id`，需要會員 Bearer token，修改或設為預設超商門市
- `DELETE /api/members/addresses/:id`，需要會員 Bearer token，刪除超商門市
- `GET /api/logistics/711-stores?search=台北&page=1&pageSize=20`，搜尋 7-ELEVEN 取貨門市

超商門市新增／修改欄位為 `recipient`、`phone`、`pickupStore: { provider: "UNIMART", storeId }`，另可傳入 `isDefault`。後端會驗證門市目前有效並儲存門市資料快照；第一筆會自動設為預設，每位會員最多可儲存 20 筆。
- `POST /api/orders`，超商取貨 body 需包含 `{"shippingMethod":"store","pickupStore":{"provider":"UNIMART","storeId":"門市代碼"}}`
- `GET /api/admin/products`
- `POST /api/admin/products`
- `PUT /api/admin/products/:id`
- `DELETE /api/admin/products/:id`
- `POST /api/admin/uploads/products`，使用 `multipart/form-data` 的 `file` 欄位

後台商品 API 支援多組規格、規格選項、SKU 笛卡兒積、個別價格／原價／庫存／安全庫存，以及 `colorImages[]` 顏色共用圖片。相同顏色的所有尺寸 SKU 只儲存一張圖片；商品明細的 `variants[].imageUrl` 會自動展開對應圖片供前台使用。若設定 `ADMIN_API_TOKEN` secret，所有 `/api/admin/*` 請求都必須帶入相同 Bearer Token。

公開商品列表可使用 `search`、`category`、`categoryId`、`tagType`、`minPrice`、`maxPrice`、`dateFrom`、`dateTo` 篩選；`tagType` 支援 `new`、`popular`、`preorder`、`none`。排序支援 `new`、`popular`、`price-low`、`price-high`，並以 `page`、`pageSize` 分頁。前台商品列表固定送出 `pageSize=30`；API 固定只回傳已上架商品，`pageSize` 上限為 48。後台商品列表另外支援 `status`；兩者使用 `categoryId` 篩選時都會包含指定分類的所有子分類。

公開分類 API 以樹狀 `children[]` 回傳，並包含 `parentId`、`level`、`directProductCount` 與包含所有下層分類的 `productCount`。

## 啟動

1. 執行 `npm install`。
2. 將 `wrangler.jsonc` 的 database ID 與 `FRONTEND_ORIGIN` 改為實際值；正式圖片上傳另需設定 `PRODUCT_IMAGES` R2 binding 與 `PRODUCT_IMAGES_PUBLIC_URL`。
   正式會員驗證信另需設定 `EMAIL_FROM`、`ENVIRONMENT=production`，並以
   `wrangler secret put AUTH_SECRET` 與 `wrangler secret put RESEND_API_KEY` 設定密鑰。
3. 先從 `knock-knock-database` 套用遷移與種子資料。
4. 執行 `npm run dev`，預設網址為 `http://localhost:8787`。

本機開發會使用根目錄的 `.wrangler/shared-state`，與 `knock-knock-admin-backend` 共用同一份 D1；因此後台建立並上架的商品會直接出現在公開商品 API。

部署前可執行 `npm run typecheck` 與 `npm run build`。

正式環境應使用 `wrangler secret put ADMIN_API_TOKEN` 設定管理 API Token，不要將 Token 寫入設定檔。
本機未設定 Resend 時，後端會將隨機驗證碼寫入開發日誌，API 也只在非 production 環境回傳 `developmentCode`；正式環境不會回傳驗證碼。

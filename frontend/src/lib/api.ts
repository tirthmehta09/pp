import axios, { AxiosError } from 'axios';

export const TOKEN_KEY = 'erp_token';

export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api',
});

// Attach JWT from localStorage on every request.
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// On 401, clear token and bounce to login.
api.interceptors.response.use(
  (res) => res,
  (error: AxiosError) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem(TOKEN_KEY);
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  },
);

/** Standard API error shape from the NestJS exception filter. */
export interface ApiError {
  message: string;
  errors?: Record<string, string>;
}

export function getApiError(error: unknown): ApiError {
  const err = error as AxiosError<{ message?: string; errors?: Record<string, string> }>;
  return {
    message: err.response?.data?.message ?? 'Something went wrong.',
    errors: err.response?.data?.errors,
  };
}

/** Unwrap the { success, data } envelope. */
export async function unwrap<T>(promise: Promise<{ data: { data: T } }>): Promise<T> {
  const res = await promise;
  return res.data.data;
}

// ---- Endpoint helpers ----
export const Api = {
  login: (login: string, password: string) =>
    unwrap<{ token: string; user: any }>(api.post('/auth/login', { login, password })),
  me: () => unwrap<any>(api.get('/auth/me')),

  processes: () => unwrap<any[]>(api.get('/processes')),
  createService: (body: { name: string; appliesTo?: string }) =>
    unwrap<any>(api.post('/processes/services', body)),

  dashboard: () => unwrap<any>(api.get('/dashboard')),

  vendors: {
    list: (params?: Record<string, any>) => unwrap<any[]>(api.get('/vendors', { params })),
    get: (id: number) => unwrap<any>(api.get(`/vendors/${id}`)),
    create: (body: any) => unwrap<any>(api.post('/vendors', body)),
    update: (id: number, body: any) => unwrap<any>(api.put(`/vendors/${id}`, body)),
    remove: (id: number) => unwrap<any>(api.delete(`/vendors/${id}`)),
  },

  materials: {
    categories: () => unwrap<any[]>(api.get('/materials/categories')),
    list: () => unwrap<any[]>(api.get('/materials/list')),
    variants: (params?: Record<string, any>) =>
      unwrap<any[]>(api.get('/materials/variants', { params })),
    getVariant: (id: number) => unwrap<any>(api.get(`/materials/variants/${id}`)),
    createVariant: (body: any) => unwrap<any>(api.post('/materials/variants', body)),
    updateVariant: (id: number, body: any) =>
      unwrap<any>(api.put(`/materials/variants/${id}`, body)),
    removeVariant: (id: number) => unwrap<any>(api.delete(`/materials/variants/${id}`)),
    // Inventory
    stock: (search?: string) => unwrap<any[]>(api.get('/materials/stock', { params: { search } })),
    movements: (variantId?: number) => unwrap<any[]>(api.get('/materials/stock/movements', { params: { variantId } })),
    adjustStock: (variantId: number, body: { type: string; quantity: number; note?: string }) =>
      unwrap<any>(api.post(`/materials/variants/${variantId}/stock`, body)),
  },

  items: {
    meta: () => unwrap<any>(api.get('/items/meta')),
    nextDesignCode: (shortName?: string) =>
      unwrap<{ sampleDesignCode: string }>(api.get('/items/next-design-code', { params: { shortName } })),
    list: (params?: Record<string, any>) => unwrap<any[]>(api.get('/items', { params })),
    get: (id: number) => unwrap<any>(api.get(`/items/${id}`)),
    create: (body: any) => unwrap<any>(api.post('/items', body)),
    update: (id: number, body: any) => unwrap<any>(api.put(`/items/${id}`, body)),
    remove: (id: number) => unwrap<any>(api.delete(`/items/${id}`)),
    deleteImage: (id: number, imageId: number) =>
      unwrap<any>(api.delete(`/items/${id}/images/${imageId}`)),
  },

  casting: {
    nextBatchNumber: () => unwrap<{ batchNumber: string }>(api.get('/casting/next-batch-number')),
    batches: (params?: Record<string, any>) => unwrap<any[]>(api.get('/casting/batches', { params })),
    batch: (id: number) => unwrap<any>(api.get(`/casting/batches/${id}`)),
    batchVendors: (id: number) => unwrap<any[]>(api.get(`/casting/batches/${id}/vendors`)),
    createBatch: (body: any) => unwrap<any>(api.post('/casting/batches', body)),
    updateBatch: (id: number, body: any) => unwrap<any>(api.put(`/casting/batches/${id}`, body)),
    removeBatch: (id: number) => unwrap<any>(api.delete(`/casting/batches/${id}`)),
    pending: (batchId: number, vendorId: number) =>
      unwrap<any>(api.get(`/casting/batches/${batchId}/pending/${vendorId}`)),
    receipts: (params?: Record<string, any>) => unwrap<any[]>(api.get('/casting/receipts', { params })),
    produced: (itemId?: number) => unwrap<{ rows: any[]; byDesign: any[] }>(api.get('/casting/produced', { params: { itemId } })),
    settle: (body: { stageIds: number[]; nextProcessId: number; color?: string; vendorId?: number; maxQty?: number; targetBatchId?: number }) =>
      unwrap<{ forwarded: number }>(api.post('/casting/settle', body)),
    planForward: (stageId: number, body: { nextProcessId: number | null; vendorId?: number | null; color?: string | null; targetBatchId?: number | null }) =>
      unwrap<{ id: number }>(api.post(`/casting/stages/${stageId}/plan-forward`, body)),
    createReceipt: (body: any) => unwrap<any>(api.post('/casting/receipts', body)),
    deleteReceipt: (receiptId: number) => unwrap<any>(api.delete(`/casting/receipts/${receiptId}`)),
    closeItem: (batchItemId: number, reason?: string) =>
      unwrap<any>(api.post(`/casting/batch-items/${batchItemId}/close`, { reason })),
    closeBatch: (batchId: number, reason?: string) =>
      unwrap<{ closedStages: number }>(api.post(`/casting/batches/${batchId}/close`, { reason })),
    reopenBatch: (batchId: number) =>
      unwrap<{ id: number }>(api.post(`/casting/batches/${batchId}/reopen`, {})),
    reopenItem: (batchItemId: number) =>
      unwrap<any>(api.post(`/casting/batch-items/${batchItemId}/reopen`, {})),
    forwardStage: (batchItemId: number, body: { processId: number; quantity: number; vendorId?: number; vendorDesignReference?: string; weight?: number; totalWeight?: number; costPerKg?: number; color?: string; remarks?: string; bringsOwnMaterials?: boolean; materialBufferPercent?: number; materialIssueOverride?: { variantId: number; issuedQty: number }[] }) =>
      unwrap<any>(api.post(`/casting/batch-items/${batchItemId}/forward`, body)),
    previewStickingIssue: (body: { itemId: number; splits: { color?: string | null; quantity: number }[]; bufferPercent?: number }) =>
      unwrap<{ lines: { variantId: number; variantCode: string; variantName: string; unit: string | null; required: number; defaultIssue: number; stockQty: number }[] }>(
        api.post('/casting/preview-sticking-issue', body),
      ),
    updateStage: (batchItemId: number, body: { vendorId?: number; vendorDesignReference?: string; quantity?: number; weight?: number; totalWeight?: number; costPerKg?: number; color?: string; remarks?: string }) =>
      unwrap<any>(api.put(`/casting/batch-items/${batchItemId}`, body)),
    vendorLedger: (vendorId: number, from?: string, to?: string) =>
      unwrap<any>(api.get(`/casting/vendor-ledger/${vendorId}`, { params: { from, to } })),
    pdfUrl: (batchId: number, vendorId: number, processId?: number) =>
      `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api'}/casting/batches/${batchId}/pdf/${vendorId}${processId ? `?processId=${processId}` : ''}`,
    stagePdfUrl: (stageId: number) =>
      `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api'}/casting/stages/${stageId}/pdf`,
    receiptPdfUrl: (receiptId: number) =>
      `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api'}/casting/receipts/${receiptId}/pdf`,
  },

  materialIssues: {
    list: (params?: { vendorId?: number; status?: string }) =>
      unwrap<any[]>(api.get('/material-issues', { params })),
    get: (id: number) => unwrap<any>(api.get(`/material-issues/${id}`)),
    nextVoucherNumber: () => unwrap<{ voucherNumber: string }>(api.get('/material-issues/next-voucher-number')),
    vendorHoldings: (vendorId?: number) =>
      unwrap<any[]>(api.get('/material-issues/vendor-holdings', { params: { vendorId } })),
    create: (body: {
      vendorId: number; batchId?: number; stageId?: number; issueDate?: string; notes?: string;
      lines: { variantId: number; issuedQty: number; notes?: string }[];
    }) => unwrap<{ id: number; voucherNumber: string }>(api.post('/material-issues', body)),
    recordReturn: (id: number, body: { lines: { lineId: number; returnedQty: number; consumedQty?: number; notes?: string }[]; notes?: string }) =>
      unwrap<any>(api.post(`/material-issues/${id}/return`, body)),
    vendorReturn: (body: { vendorId: number; items: { variantId: number; returnedQty: number }[] }) =>
      unwrap<{ items: { variantId: number; returned: number; allocations: { voucherNumber: string; qty: number }[] }[] }>(
        api.post('/material-issues/vendor-return', body),
      ),
    close: (id: number, body?: { reason?: string }) =>
      unwrap<any>(api.post(`/material-issues/${id}/close`, body ?? {})),
    remove: (id: number) => unwrap<any>(api.delete(`/material-issues/${id}`)),
    issuePdfUrl: (id: number) =>
      `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api'}/material-issues/${id}/pdf`,
    returnPdfUrl: (id: number) =>
      `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api'}/material-issues/${id}/return-pdf`,
  },

  upload: async (file: File, module: string, type: 'image' | 'cad' = 'image') => {
    const fd = new FormData();
    fd.append('file', file);
    return unwrap<{ path: string; url: string }>(
      api.post(`/uploads?module=${module}&type=${type}`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      }),
    );
  },
};

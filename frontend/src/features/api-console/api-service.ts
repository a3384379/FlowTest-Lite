import { apiDetail, client, getAsset, type ApiDetail, type RequestSnapshot } from '../../lib/api'
import type { RequestOverrides } from '../../flow/editor/request-overrides'

export type { ApiVersionInput } from '../../lib/api'

export async function getApiDetail(id: string): Promise<ApiDetail> {
  return apiDetail(await getAsset('api', id))
}

export function previewApi(
  apiId: string, environmentId?: string | null, overrides: RequestOverrides = {},
): Promise<RequestSnapshot> {
  return client.post(`/requests/${apiId}/preview`, {
    environment_id: environmentId ?? null,
    request_overrides: overrides,
  }).then((res) => res.data)
}

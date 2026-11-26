import { apiDetail, type ApiDetail, type RequestSnapshot } from '../../lib/api'
import { useProjectApi } from '../../lib/project-context'
import type { RequestOverrides } from '../../flow/editor/request-overrides'

export type { ApiVersionInput } from '../../lib/api'

export function useApiService() {
  const { client, getAsset } = useProjectApi()
  return {
    async getApiDetail(id: string): Promise<ApiDetail> {
      return apiDetail(await getAsset('api', id))
    },
    previewApi(apiId: string, environmentId?: string | null, overrides: RequestOverrides = {}): Promise<RequestSnapshot> {
      return client.post(`/requests/${apiId}/preview`, {
        environment_id: environmentId ?? null,
        request_overrides: overrides,
      }).then((res) => res.data)
    },
  }
}

export interface GenerateCapture {
  fulfillUnitIds: string[]
  docUrl: string | null
  statsUnitIds: string[]
}

/** Parse the shipping_doc/generate request body + response body into a typed struct.
 *  NB: response stats[].order_id is the fulfill_unit_id (verified), not the main order id. */
export function parseGenerateCapture(reqText: string, respText: string): GenerateCapture {
  let fulfillUnitIds: string[] = []
  let docUrl: string | null = null
  let statsUnitIds: string[] = []
  try {
    const req = JSON.parse(reqText) as { fulfill_unit_id_list?: unknown[] }
    fulfillUnitIds = (req.fulfill_unit_id_list ?? []).map((x) => String(x))
  } catch { /* ignore */ }
  try {
    const data = (JSON.parse(respText) as { data?: { doc_url?: string; stats?: { order_id?: unknown }[] } }).data
    docUrl = data?.doc_url ?? null
    statsUnitIds = (data?.stats ?? []).map((s) => String(s.order_id))
  } catch { /* ignore */ }
  return { fulfillUnitIds, docUrl, statsUnitIds }
}

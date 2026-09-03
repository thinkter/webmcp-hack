/**
 * The operator catalog.
 *
 * This is the single source of truth. The node library, the inspector, the
 * renderer, and the WebMCP tool surface are all derived from it, so the editor
 * cannot advertise an operator that the engine is unable to run.
 */

import { chopOperators } from './chops'
import { compositeOperators } from './composite'
import { customOperators } from './custom'
import { filterOperators } from './filters'
import { generatorOperators } from './generators'
import { outputOperators } from './outputs'
import { sourceOperators } from './sources'
import { warpOperators } from './warp'
import type { OperatorCategory, OperatorSpec } from './kit'

export const operators: OperatorSpec[] = [
  ...sourceOperators,
  ...generatorOperators,
  ...filterOperators,
  ...warpOperators,
  ...compositeOperators,
  ...customOperators,
  ...chopOperators,
  ...outputOperators,
]

const duplicates = operators
  .map((operator) => operator.id)
  .filter((id, index, all) => all.indexOf(id) !== index)
if (duplicates.length) {
  throw new Error(`Duplicate operator ids in the catalog: ${duplicates.join(', ')}`)
}

export const operatorMap = new Map(operators.map((operator) => [operator.id, operator]))

export const getOperator = (id: string | undefined): OperatorSpec | undefined =>
  id ? operatorMap.get(id) : undefined

export const CATEGORY_ORDER: Array<[OperatorCategory, string]> = [
  ['source', 'Sources'],
  ['generator', 'Generators'],
  ['filter', 'Filters'],
  ['warp', 'Warp'],
  ['composite', 'Composite'],
  ['control', 'Control'],
  ['audio', 'Audio'],
  ['output', 'Outputs'],
]

/** Free-text search across labels, ids, descriptions, keywords, and TD names. */
export function searchOperators(query: string): OperatorSpec[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return operators
  const terms = needle.split(/\s+/)
  return operators
    .map((operator) => {
      const haystack = [
        operator.label,
        operator.id,
        operator.description,
        operator.td ?? '',
        ...(operator.keywords ?? []),
      ]
        .join(' ')
        .toLowerCase()
      if (!terms.every((term) => haystack.includes(term))) return null
      // Prefer prefix matches on the label so typing "blu" surfaces Blur first.
      const score = operator.label.toLowerCase().startsWith(terms[0]) ? 0 : 1
      return { operator, score }
    })
    .filter((entry): entry is { operator: OperatorSpec; score: number } => entry !== null)
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.operator)
}

export * from './kit'
export { BLEND_MODES } from './composite'
export { EXTERNAL_SOURCE_IDS } from './sources'
export { DEFAULT_USER_WGSL } from './custom'

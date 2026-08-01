/**
 * Type definitions for comment export functionality. These types define the
 * structure of exported comments for ticketing system integration.
 */

export interface BaseComment {
  author: string
  datetime: number // epoch
  content: string
}

export type ExportedComment = BaseComment & {
  children: BaseComment[]
  sourceFile: string
  startLine: number
  endLine: number
}

export type ExportedComments = ExportedComment[]

/**
 * Internal database comment representation (from SQLite)
 */
export interface DbComment {
  id: string
  slug: string
  part: number
  file: string
  line_from: number
  line_to: number
  author: string
  body: string
  parent_id: string | null
  resolved: number
  created_at: string
}

/**
 * API comment representation (camelCase)
 */
export interface ApiComment {
  id: string
  slug: string
  part: number
  file: string
  lineFrom: number
  lineTo: number
  author: string
  body: string
  parentId: string | null
  resolved: boolean
  createdAt: string
}

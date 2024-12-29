import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import axios from 'axios'

import {
	DeleteResponseObject,
	FindManyResponseObject,
	FindOneResponseObject,
	IsUniqueResponse,
} from '../dtos/response.dto'
import { Logger } from '../helpers/Logger'
import { Pagination } from '../helpers/Pagination'
import {
	DataSourceColumnType,
	DataSourceCreateOneOptions,
	DataSourceDeleteOneOptions,
	DataSourceFindManyOptions,
	DataSourceFindOneOptions,
	DataSourceFindTotalRecords,
	DataSourceSchema,
	DataSourceSchemaColumn,
	DataSourceSchemaRelation,
	DataSourceType,
	DataSourceUniqueCheckOptions,
	DataSourceUpdateOneOptions,
	DataSourceWhere,
	WhereOperator,
} from '../types/datasource.types'
import { AirtableColumnType } from '../types/datasources/airtable.types'

const DATABASE_TYPE = DataSourceType.AIRTABLE
const ENDPOINT = 'https://api.airtable.com/v0'

@Injectable()
export class Airtable {
	constructor(
		private readonly configService: ConfigService,
		private readonly logger: Logger,
		private readonly pagination: Pagination,
	) {}

	async createRequest(options: {
		endpoint: string
		method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
		data?: any
		x_request_id?: string
	}): Promise<any> {
		if (!options.method) {
			options.method = 'GET'
		}

		const [apiKey, baseId] = this.configService.get('database.host').split('://')[1].split('@')

		const endpoint = options.endpoint.replace('BaseId', baseId)

		try {
			const response = await axios({
				method: options.method,
				url: `${ENDPOINT}${endpoint}`,
				data: options.data,
				headers: {
					Authorization: `Bearer ${apiKey}`,
				},
			})

			return response.data
		} catch (e) {
			this.logger.error(`[${DATABASE_TYPE}] ${e.message}`, options.x_request_id)
			console.error({
				...e.response.data,
				status: e.response.status,
				statusText: e.response.statusText,
				request: {
					method: options.method,
					url: `${ENDPOINT}${endpoint}`,
					data: options.data,
					headers: {
						Authorization: `Bearer ${apiKey}`,
					},
				},
			})
			this.logger.error(`Data passed: `, options.x_request_id)
		}
	}

	async checkConnection(options: { x_request_id?: string }): Promise<boolean> {
		try {
			await this.createRequest({
				endpoint: '/meta/bases',
				method: 'GET',
				x_request_id: options.x_request_id,
			})
			return true
		} catch (e) {
			this.logger.error(
				`[${DATABASE_TYPE}] Error checking database connection - ${e.message}`,
				options.x_request_id,
			)
			return false
		}
	}

	/**
	 * List Tables
	 */

	async listTables(options: { x_request_id?: string }): Promise<string[]> {
		try {
			this.logger.debug(`[${DATABASE_TYPE}] List Tables`, options.x_request_id)

			const response = await this.createRequest({
				endpoint: `/meta/bases/BaseId/tables`,
				x_request_id: options.x_request_id,
			})

			const tables = response.tables.map((table: any) => table.name)

			this.logger.debug(`[${DATABASE_TYPE}] Tables: ${tables.join(',')}`, options.x_request_id)

			return tables
		} catch (e) {
			this.logger.warn(`[${DATABASE_TYPE}] Error listing tables - ${e.message}`)
			throw new Error(e)
		}
	}

	/**
	 * Get Table Schema
	 * @param repository
	 * @param table_name
	 */

	async getSchema(options: { table: string; x_request_id?: string }): Promise<DataSourceSchema> {
		try {
			this.logger.debug(`[${DATABASE_TYPE}] Get Schema for table ${options.table}`, options.x_request_id)

			const response = await this.createRequest({
				endpoint: `/meta/bases/BaseId/tables`,
				x_request_id: options.x_request_id,
			})

			const table = response.tables.find((t: any) => t.name === options.table)

			if (!table) {
				throw new Error('Table not found')
			}

			let columns: DataSourceSchemaColumn[] = []
			let relations: DataSourceSchemaRelation[] = []

			//pass in ID column as primary key
			columns.push({
				field: 'id',
				type: DataSourceColumnType.STRING,
				nullable: false,
				required: false,
				primary_key: true,
				unique_key: true,
				foreign_key: false,
				default: null,
				extra: {
					note: 'Airtable Autogenerated ID',
				},
			})

			for (const field of table.fields) {
				if (field.type === AirtableColumnType.MULTIPLE_RECORD_LINKS) {
					let linkedTable = response.tables.find((t: any) => t.id === field.options.linkedTableId)

					relations.push({
						table: linkedTable.name,
						column: 'id',
						org_table: options.table,
						org_column: field.name,
					})
				}

				columns.push({
					field: field.name,
					type: this.fieldMapper(field.type),
					nullable: true,
					required: false,
					primary_key: false,
					unique_key: false,
					foreign_key: field.type === AirtableColumnType.MULTIPLE_RECORD_LINKS,
					default: null,
					extra: field,
				})
			}

			//Build reverse relations
			for (const table of response.tables) {
				for (const field of table.fields) {
					if (field.type === AirtableColumnType.MULTIPLE_RECORD_LINKS) {
						if (field.options.linkedTableId === table.id) {
							relations.push({
								table: options.table,
								column: field.name,
								org_table: table.name,
								org_column: 'id',
							})
						}
					}
				}
			}

			const schema = {
				table: options.table,
				columns,
				primary_key: columns.find(column => column.primary_key)?.field,
				relations,
			}

			return schema
		} catch (e) {
			this.logger.warn(`[${DATABASE_TYPE}] Error getting schema - ${e.message}`)
			throw new Error(e)
		}
	}

	/**
	 * Insert a record
	 */

	async createOne(options: DataSourceCreateOneOptions, x_request_id?: string): Promise<FindOneResponseObject> {
		this.logger.debug(
			`[${DATABASE_TYPE}] Create Record on ${options.schema.table}: ${JSON.stringify(options.data)}`,
			x_request_id,
		)

		try {
			for (const col of options.schema.columns) {
				if (col.foreign_key) {
					if (options.data[col.field]) {
						if (!Array.isArray(options.data[col.field])) {
							options.data[col.field] = [options.data[col.field]]
						}

						const linkedTable = options.schema.relations.find(r => r.org_column === col.field)

						for (const id of options.data[col.field]) {
							const linkedSchema = await this.getSchema({ table: linkedTable.table })
							const linkedRecord = await this.findOne(
								{
									schema: linkedSchema,
									where: [{ column: 'id', operator: WhereOperator.equals, value: id }],
								},
								x_request_id,
							)

							if (!linkedRecord) {
								throw new Error('Linked record not found')
							}
						}
					}
				}
			}

			const result = await this.createRequest({
				endpoint: `/BaseId/${options.schema.table}`,
				method: 'POST',
				data: {
					records: [
						{
							fields: options.data,
						},
					],
				},
				x_request_id,
			})

			if (!result.records || result.records.length === 0) {
				throw new Error('Record not created')
			}

			this.logger.debug(`[${DATABASE_TYPE}] Results: ${JSON.stringify(result)} - ${x_request_id}`)

			return {
				id: result.records[0].id,
				...result.records[0].fields,
			}
		} catch (e) {
			this.logger.warn(`[${DATABASE_TYPE}] Error executing query`, x_request_id)
			this.logger.warn({
				data: options.data,
				error: {
					message: e.message,
				},
			})
			throw new Error(e)
		}
	}

	/**
	 * Find single record
	 */

	async findOne(options: DataSourceFindOneOptions, x_request_id: string): Promise<FindOneResponseObject | undefined> {
		try {
			this.logger.debug(
				`[${DATABASE_TYPE}] Find Record on ${options.schema.table}: ${JSON.stringify(options.where)}`,
				x_request_id,
			)

			const fields =
				options.fields?.length > 0
					? options.fields
					: [...options.schema.columns.map(c => c.field)].filter(f => f !== 'id')

			const id = options.where.find(w => w.column === options.schema.primary_key)?.value

			if (!id) {
				// Find Many and return first result
				const results = await this.findMany(
					{
						fields,
						schema: options.schema,
						where: options.where,
						limit: 1,
						offset: 0,
					},
					x_request_id,
				)

				return results.data[0]
			}

			let endpoint = `/BaseId/${options.schema.table}/${id}`

			const result = await this.createRequest({
				endpoint,
				x_request_id,
			})

			if (!result.id) {
				throw new Error('Record not found')
			}

			this.logger.debug(`[${DATABASE_TYPE}] Result: ${JSON.stringify(result)}`, x_request_id)

			return this.formatOutput(options, {
				id: result.id,
				...result.fields,
			})
		} catch (e) {
			this.logger.warn(`[${DATABASE_TYPE}] Error executing query`, x_request_id)
			this.logger.warn({
				data: options.where,
				error: {
					message: e.message,
				},
			})
			throw new Error(e)
		}
	}

	/**
	 * Find multiple records
	 */

	async findMany(options: DataSourceFindManyOptions, x_request_id: string): Promise<FindManyResponseObject> {
		//If primary key is passed in where clause, return single record
		if (options.where.length === 1 && options.where[0].column === options.schema.primary_key) {
			return {
				limit: options.limit,
				offset: options.offset,
				total: 1,
				pagination: {
					total: 1,
					page: {
						current: this.pagination.current(options.limit, options.offset),
						prev: this.pagination.previous(options.limit, options.offset),
						next: this.pagination.next(options.limit, options.offset, 1),
						first: this.pagination.first(options.limit),
						last: this.pagination.last(options.limit, 1),
					},
				},
				data: [
					await this.findOne(
						{
							schema: options.schema,
							where: options.where,
							fields: options.fields,
						},
						x_request_id,
					),
				],
			}
		}

		const total = await this.findTotalRecords(options, x_request_id)

		try {
			this.logger.debug(
				`[${DATABASE_TYPE}] Find Record on ${options.schema.table}: ${JSON.stringify(options.where)}`,
				x_request_id,
			)

			// Sort
			let sort = []

			if (options.sort) {
				for (const s of options.sort) {
					sort.push({
						field: s.column,
						direction: s.operator.toLowerCase(),
					})
				}
			}

			if (!options.limit) {
				options.limit = this.configService.get<number>('database.defaults.limit') ?? 20
			}

			let offset = undefined

			if (options.offset) {
				offset = options.offset
			}

			const filterByFormula = await this.whereToFilter(options.where, options.schema)

			const fields =
				options.fields?.length > 0
					? options.fields
					: [...options.schema.columns.map(c => c.field)].filter(f => f !== 'id')

			if (offset) {
				//Offset not supported by airtable.
				//Returning prior records, then use the offset provided by airtable, however if > 100, multiple calls will be needed

				if (offset > 100) {
					let tempOffet = 0
					let airtableoffset = null

					while (tempOffet < offset) {
						const data = {
							pageSize: 100,
							fields,
							filterByFormula,
							sort,
							offset: airtableoffset,
						}

						//remove undefined values
						Object.keys(data).forEach(
							key => data[key] === undefined || (data[key] === null && delete data[key]),
						)

						const result = await this.createRequest({
							method: 'POST',
							endpoint: `/BaseId/${options.schema.table}/listRecords`,
							data,
							x_request_id,
						})

						tempOffet += 100
						airtableoffset = result.offset
					}
				} else {
					const result = await this.createRequest({
						method: 'POST',
						endpoint: `/BaseId/${options.schema.table}/listRecords`,
						data: {
							pageSize: options.offset,
							fields,
							filterByFormula,
							sort,
						},
						x_request_id,
					})
					offset = result.offset
				}
			}

			const data = {
				fields,
				filterByFormula,
				sort,
				maxRecords: options.limit > 100 ? 100 : options.limit,
				pageSize: options.limit > 100 ? 100 : options.limit,
				offset: offset ?? null,
			}

			//remove undefined values
			Object.keys(data).forEach(key => data[key] === undefined || (data[key] === null && delete data[key]))

			const findAllRequest = {
				method: 'POST',
				endpoint: `/BaseId/${options.schema.table}/listRecords`,
				data,
				x_request_id,
			}

			const result = await this.createRequest(<any>findAllRequest)

			const results = <any>result.records.map((record: any) => {
				return {
					id: record.id,
					...record.fields,
				}
			})

			this.logger.debug(`[${DATABASE_TYPE}] Results: ${JSON.stringify(results)}`, x_request_id)

			return {
				limit: options.limit,
				offset: options.offset,
				total,
				pagination: {
					total: results.length,
					page: {
						current: this.pagination.current(options.limit, options.offset),
						prev: this.pagination.previous(options.limit, options.offset),
						next: this.pagination.next(options.limit, options.offset, total),
						first: this.pagination.first(options.limit),
						last: this.pagination.last(options.limit, total),
					},
				},
				data: results,
			}
		} catch (e) {
			this.logger.warn(`[${DATABASE_TYPE}] Error executing query`, x_request_id)
			this.logger.warn({
				data: options.where,
				error: {
					message: e.message,
				},
			})
			throw new Error(e)
		}
	}

	/**
	 * Get total records with where conditions
	 */

	async findTotalRecords(options: DataSourceFindTotalRecords, x_request_id: string): Promise<number> {
		try {
			this.logger.debug(
				`[${DATABASE_TYPE}] Find Records on ${options.schema.table}: ${JSON.stringify(options.where)} ${x_request_id ?? ''}`,
			)
			const filterByFormula = await this.whereToFilter(options.where, options.schema)

			let offset = undefined
			let total = 0
			let finished = false

			while (!finished) {
				const data = {
					pageSize: 100,
					fields: [],
					filterByFormula,
					offset,
				}

				//remove undefined values
				Object.keys(data).forEach(key => data[key] === undefined || (data[key] === null && delete data[key]))

				const result = await this.createRequest({
					method: 'POST',
					endpoint: `/BaseId/${options.schema.table}/listRecords`,
					data,
					x_request_id,
				})

				if (!result.records || result.records.length === 0) {
					finished = true
				} else if (result.records.length < 100) {
					total += result.records.length
					offset = result.offset
					finished = true
				} else {
					offset += 100
					offset = result.offset
					total = +result.records.length
				}
			}

			this.logger.debug(`[${DATABASE_TYPE}] Total Records: ${total} ${x_request_id ?? ''}`)
			return total
		} catch (e) {
			this.logger.warn(`[${DATABASE_TYPE}] Error executing query ${x_request_id ?? ''}`)
			this.logger.warn({
				data: options.where,
				error: {
					message: e.message,
				},
			})
			throw new Error(e)
		}
	}

	/**
	 * Update one records
	 */

	async updateOne(options: DataSourceUpdateOneOptions, x_request_id: string): Promise<FindOneResponseObject> {
		if (options.data[options.schema.primary_key]) {
			delete options.data[options.schema.primary_key]
		}

		try {
			this.logger.debug(
				`[${DATABASE_TYPE}] Update Record on ${options.schema.table}: ${JSON.stringify(options.data)} ${x_request_id ?? ''}`,
			)

			for (const col of options.schema.columns) {
				if (col.foreign_key) {
					if (options.data[col.field]) {
						if (!Array.isArray(options.data[col.field])) {
							options.data[col.field] = [options.data[col.field]]
						}

						const linkedTable = options.schema.relations.find(r => r.org_column === col.field)

						for (const id of options.data[col.field]) {
							const linkedSchema = await this.getSchema({ table: linkedTable.table })
							const linkedRecord = await this.findOne(
								{
									schema: linkedSchema,
									where: [{ column: 'id', operator: WhereOperator.equals, value: id }],
								},
								x_request_id,
							)

							if (!linkedRecord) {
								throw new Error('Linked record not found')
							}
						}
					}
				}
			}

			const result = await this.createRequest({
				endpoint: `/BaseId/${options.schema.table}/${options.id}`,
				method: 'PATCH',
				data: {
					fields: options.data,
				},
				x_request_id,
			})

			if (!result.id) {
				throw new Error('Record not updated')
			}

			this.logger.debug(`[${DATABASE_TYPE}] Result: ${JSON.stringify(result)} ${x_request_id ?? ''}`)

			return {
				id: result.id,
				...result.fields,
			}
		} catch (e) {
			this.logger.warn(`[${DATABASE_TYPE}] Error executing query ${x_request_id ?? ''}`)
			this.logger.warn({
				data: options.data,
				error: {
					message: e.message,
				},
			})
			throw new Error(e)
		}
	}

	/**
	 * Delete single record
	 */

	async deleteOne(options: DataSourceDeleteOneOptions, x_request_id: string): Promise<DeleteResponseObject> {
		try {
			this.logger.debug(
				`[${DATABASE_TYPE}] Delete Record on ${options.schema.table}: ${options.id} ${x_request_id ?? ''}`,
			)

			let result

			if (options.softDelete) {
				result = await this.updateOne(
					{
						id: options.id,
						schema: options.schema,
						data: {
							[options.softDelete]: new Date().toISOString().slice(0, 19).replace('T', ' '),
						},
					},
					x_request_id,
				)
			} else {
				result = await this.createRequest({
					endpoint: `/BaseId/${options.schema.table}/${options.id}`,
					method: 'DELETE',
				})
			}

			this.logger.debug(`[${DATABASE_TYPE}] Result: ${JSON.stringify(result)} ${x_request_id ?? ''}`)

			if (result.id) {
				return {
					deleted: 1,
				}
			}
		} catch (e) {
			this.logger.warn(`[${DATABASE_TYPE}] Error executing query ${x_request_id ?? ''}`)
			this.logger.warn({
				data: options.id,
				error: {
					message: e.message,
				},
			})
			throw new Error(e)
		}
	}

	/**
	 * Create table from schema object
	 */

	async createTable(schema: DataSourceSchema, x_request_id?: string): Promise<boolean> {
		try {
			this.logger.debug(`[${DATABASE_TYPE}] Create table ${schema.table}`, x_request_id)

			//check if table exists
			const tables = await this.listTables({ x_request_id })

			if (!tables.includes(schema.table)) {
				const fields = schema.columns.map(column => {
					//skip ID column as it is created by default
					if (column.field === 'id') {
						column.field = schema.table + 'Id'
					}

					let options

					//https://airtable.com/developers/web/api/field-model
					switch (column.type) {
						case DataSourceColumnType.NUMBER:
							options = {
								precision: column.extra.decimal ?? 0,
							}
							break

						case DataSourceColumnType.ENUM:
							options = {
								choices: column.enums.map(e => ({ name: e })),
							}
							break

						case DataSourceColumnType.BOOLEAN:
							options = {
								icon: 'check',
								color: 'grayBright',
							}
							break

						case DataSourceColumnType.DATE:
							let timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'client'
							if (timeZone === 'UTC') {
								timeZone = 'utc'
							}

							options = {
								timeZone,
								dateFormat: {
									format: 'YYYY-MM-DD',
									name: 'iso',
								},
								timeFormat: {
									format: 'HH:mm',
									name: '24hour',
								},
							}
							break
					}

					return {
						name: column.field,
						type: this.fieldMapperRev(column.type),
						options,
					}
				})

				const result = await this.createRequest({
					endpoint: `/meta/bases/BaseId/tables`,
					method: 'POST',
					data: {
						name: schema.table,
						fields,
					},
					x_request_id,
				})

				if (!result.id) {
					throw new Error('Table not created')
				}

				this.logger.debug(`[${DATABASE_TYPE}] Table ${schema.table} created`, x_request_id)
			}

			return true
		} catch (e) {
			this.logger.warn(`[${DATABASE_TYPE}] Error executing query`, x_request_id)
			this.logger.warn({
				error: {
					message: e.message,
				},
			})
			return false
		}
	}

	async truncate(table: string, x_request_id?: string): Promise<void> {
		try {
			this.logger.debug(`[${DATABASE_TYPE}] Truncate table ${table}`)
			const schema = await this.getSchema({ table })

			let finished = false

			while (!finished) {
				const result = await this.createRequest({
					method: 'POST',
					endpoint: `/BaseId/${schema.table}/listRecords`,
					data: {
						pageSize: 10,
						fields: [schema.primary_key],
					},
					x_request_id,
				})

				if (!result.records || result.records.length === 0) {
					finished = true
				} else {
					for (const record of result.records) {
						await this.createRequest({
							endpoint: `/BaseId/${schema.table}/${record.id}`,
							method: 'DELETE',
						})
					}
				}
			}

			this.logger.debug(`[${DATABASE_TYPE}] Collection ${table} truncated`)
		} catch (e) {
			this.logger.warn(`[${DATABASE_TYPE}] Error executing query`)
			this.logger.warn({
				error: {
					message: e.message,
				},
			})
		}
	}

	async uniqueCheck(options: DataSourceUniqueCheckOptions, x_request_id: string): Promise<IsUniqueResponse> {
		this.logger.debug(`[${DATABASE_TYPE}] Unique Check not applicable: ${JSON.stringify(options)}`, x_request_id)

		return {
			valid: true,
		}
	}

	/**
	 * Convert a Llana DatabaseWhere to Airtable filterByFormula object
	 */
	async whereToFilter(where: DataSourceWhere[], schema: DataSourceSchema): Promise<string> {
		let filter = ''

		if (!where || where.length === 0) {
			return filter
		}

		for (const w of where) {
			//If column type is checkbox, pass empty string as value for false

			const columnSchema = schema.columns.find(c => c.field === w.column)

			if (columnSchema.type === DataSourceColumnType.BOOLEAN && w.value === false) {
				w.value = ''
			}

			switch (w.operator) {
				case WhereOperator.equals:
					filter += `{${w.column}}="${w.value}",`
					break

				case WhereOperator.not_equals:
					filter += `{${w.column}}!="${w.value}",`
					break

				case WhereOperator.gt:
					filter += `{${w.column}}>"${w.value}",`
					break

				case WhereOperator.gte:
					filter += `{${w.column}}>="${w.value}",`
					break

				case WhereOperator.lt:
					filter += `{${w.column}}<"${w.value}",`
					break

				case WhereOperator.lte:
					filter += `{${w.column}}<="${w.value}",`
					break

				// case WhereOperator.in:
				// 	filter[w.column] = {
				// 		$in: w.value,
				// 	}
				// 	break

				// case WhereOperator.not_in:
				// 	filter[w.column] = {
				// 		$nin: w.value,
				// 	}
				// 	break

				case WhereOperator.like:
				case WhereOperator.search:
					filter += `SEARCH("${w.value}",{${w.column}}),`
					break

				case WhereOperator.not_like:
					filter += `NOT(SEARCH("${w.value}",{${w.column}})),`
					break

				// case WhereOperator.not_null:
				// 	filter += `{${w.column}}`
				// 	break

				// case WhereOperator.null:
				// 	filter[w.column] = null
				// 	break

				default:
					this.logger.warn(`[${DATABASE_TYPE}] Operator not supported: ${w.operator}`)
					break
			}
		}

		// Remove trailing comma
		filter = filter.slice(0, -1)

		if (where.length > 1) {
			return filter ? `AND(${filter})` : ''
		} else {
			return filter
		}
	}

	/**
	 * Convert a AirtableColumnType to Llana DatabaseColumnType
	 */

	private fieldMapper(type: AirtableColumnType): DataSourceColumnType {
		switch (type) {
			case AirtableColumnType.EMAIL:
			case AirtableColumnType.URL:
			case AirtableColumnType.BARCODE:
			case AirtableColumnType.MULTILINE_TEXT:
			case AirtableColumnType.RICH_TEXT:
			case AirtableColumnType.DURATION:
			case AirtableColumnType.PHONE_NUMBER:
			case AirtableColumnType.SINGLE_LINE_TEXT:
				return DataSourceColumnType.STRING

			case AirtableColumnType.AUTO_NUMBER:
			case AirtableColumnType.NUMBER:
			case AirtableColumnType.COUNT:
			case AirtableColumnType.PERCENT:
			case AirtableColumnType.CURRENCY:
			case AirtableColumnType.RATING:
				return DataSourceColumnType.NUMBER

			case AirtableColumnType.CHECKBOX:
				return DataSourceColumnType.BOOLEAN

			case AirtableColumnType.DATE:
			case AirtableColumnType.DATE_TIME:
			case AirtableColumnType.CREATED_TIME:
			case AirtableColumnType.LAST_MODIFIED_TIME:
				return DataSourceColumnType.DATE

			case AirtableColumnType.MULTIPLE_ATTACHMENTS:
			case AirtableColumnType.MULTIPLE_COLLABORATORS:
			case AirtableColumnType.MULTIPLE_RECORD_LINKS:
			case AirtableColumnType.MULTIPLE_LOOKUP_VALUES:
			case AirtableColumnType.MULTIPLE_SELECTS:
			case AirtableColumnType.SINGLE_COLLABORATOR:
			case AirtableColumnType.FORMULA:
			case AirtableColumnType.ROLLUP:
			case AirtableColumnType.CREATED_BY:
			case AirtableColumnType.LAST_MODIFIED_BY:
			case AirtableColumnType.BUTTON:
			case AirtableColumnType.EXTERNAL_SYNC_SOURCE:
			case AirtableColumnType.AI_TEXT:
				return DataSourceColumnType.JSON

			case AirtableColumnType.SINGLE_SELECT:
				return DataSourceColumnType.ENUM

			default:
				return DataSourceColumnType.UNKNOWN
		}
	}

	/**
	 * Convert a AirtableColumnType to Llana DatabaseColumnType
	 */

	private fieldMapperRev(type: DataSourceColumnType): AirtableColumnType {
		switch (type) {
			case DataSourceColumnType.STRING:
				return AirtableColumnType.SINGLE_LINE_TEXT

			case DataSourceColumnType.NUMBER:
				return AirtableColumnType.NUMBER

			case DataSourceColumnType.BOOLEAN:
				return AirtableColumnType.CHECKBOX

			case DataSourceColumnType.DATE:
				return AirtableColumnType.DATE_TIME

			case DataSourceColumnType.JSON:
				return AirtableColumnType.MULTILINE_TEXT

			case DataSourceColumnType.ENUM:
				return AirtableColumnType.SINGLE_SELECT

			default:
				return AirtableColumnType.MULTILINE_TEXT
		}
	}

	private formatOutput(options: DataSourceFindOneOptions, data: { [key: string]: any }): object {
		// You cannot specify fields for single records with airtable, so remove any fields that are not in the schema

		if (options.fields && options.fields.length > 0) {
			for (const key in data) {
				if (key !== 'id' && !options.fields.includes(key)) {
					delete data[key]
				}
			}
		}

		for (const key in data) {
			const column = options.schema.columns.find(c => c.field === key)

			if (!column) {
				continue
			}

			data[key] = this.formatField(column.type, data[key])
		}

		return data
	}

	private formatField(type: DataSourceColumnType, value: any): any {
		if (value === null) {
			return null
		}

		switch (type) {
			case DataSourceColumnType.DATE:
				return new Date(value).toISOString()
			default:
				return value
		}
	}
}

import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { context, Logger } from "./Logger";
import { GetQueryObject } from "../types/response.types";

@Injectable()
export class Pagination {
	constructor(
		private readonly configService: ConfigService,
		private readonly logger: Logger,
	) {
		this.logger.setContext(context)
	}

    /**
     * Takes the query parameters, configs (for defualts) and returns the limit and offset
     */

    get(query: GetQueryObject): {limit: number, offset: number} {

        let limit = Number(this.configService.get<number>('database.defaults.limit'))
        let offset = 0

        if(query.limit) limit = Number(query.limit)
        if(query.offset) offset = Number(query.offset)

        if (query.page) {
            const decoded = this.decodePage(query.page)
            limit = decoded.limit
            offset = decoded.offset
        }

        return {
            limit: limit,
            offset: offset
        }		
	}

    set(limit: number, offset: number): string {
        return this.encodePage({limit: limit, offset: offset})
    }

    encodePage(options: {limit: number, offset: number}): string {
        return Buffer.from(JSON.stringify(options)).toString('base64')
    }

    decodePage(page: string): {limit: number, offset: number} {
        return JSON.parse(Buffer.from(page, 'base64').toString('ascii'))
    }
  
}
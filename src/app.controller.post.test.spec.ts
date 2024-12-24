import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { ConfigModule, ConfigService, ConfigFactory } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'
import * as request from 'supertest'
import { CustomerTestingService } from './testing/customer.testing.service'
import { AppModule } from './app.module'
import { AuthTestingService } from './testing/auth.testing.service'
import { DataSourceSchema } from './types/datasource.types'
import { UserTestingService } from './testing/user.testing.service'
import { Logger } from './helpers/Logger'
import { TIMEOUT } from './testing/testing.const'

// Import configs
import auth from './config/auth.config'
import database from './config/database.config'
import hosts from './config/hosts.config'
import jwt from './config/jwt.config'
import roles from './config/roles.config'
import { envValidationSchema } from './config/env.validation'
import { RolePermission } from './types/roles.types'

// Type the config imports
const configs: ConfigFactory[] = [auth, database, hosts, jwt, roles]

describe('App > Controller > Post', () => {
	let app: INestApplication

	let authTestingService: AuthTestingService
	let customerTestingService: CustomerTestingService
	let userTestingService: UserTestingService

	let customerSchema: DataSourceSchema
	let userSchema: DataSourceSchema

	let customers = []
	let user: any

	let jwt: string
	let userId: any
	let logger = new Logger()

	beforeAll(async () => {
		const moduleRef = await Test.createTestingModule({
			imports: [
				ConfigModule.forRoot({
					load: configs,
					validationSchema: envValidationSchema,
					isGlobal: true,
				}),
				JwtModule.registerAsync({
					imports: [ConfigModule],
					useFactory: async (configService: ConfigService) => ({
						secret: configService.get('jwt.secret'),
						signOptions: configService.get('jwt.signOptions'),
					}),
					inject: [ConfigService],
				}),
				AppModule,
			],
			providers: [AuthTestingService, CustomerTestingService, UserTestingService],
			exports: [AuthTestingService, CustomerTestingService, UserTestingService],
		}).compile()

		app = moduleRef.createNestApplication()
		await app.init()

		authTestingService = app.get<AuthTestingService>(AuthTestingService)
		customerTestingService = app.get<CustomerTestingService>(CustomerTestingService)
		userTestingService = app.get<UserTestingService>(UserTestingService)

		customerSchema = await customerTestingService.getSchema()
		userSchema = await userTestingService.getSchema()

		jwt = await authTestingService.login()
		userId = await authTestingService.getUserId(jwt)

		user = await userTestingService.mockUser()

		const result = await request(app.getHttpServer())
			.post(`/User/`)
			.send(user)
			.set('Authorization', `Bearer ${jwt}`)
			.expect(201)

		expect(result.body).toBeDefined()
		expect(result.body.email).toBeDefined()
		expect(result.body.password).toBeDefined()
		expect(result.body.password.startsWith('$2')).toBeTruthy()
		user = result.body
	}, TIMEOUT)

	beforeEach(() => {
		logger.debug('===========================================')
		logger.log('🧪 ' + expect.getState().currentTestName)
		logger.debug('===========================================')
	})

	describe('Create', () => {
		it('Create One', async function () {
			const result = await request(app.getHttpServer())
				.post(`/Customer/`)
				.send(customerTestingService.mockCustomer(userId))
				.set('Authorization', `Bearer ${jwt}`)
				.expect(201)

			expect(result.body).toBeDefined()
			expect(result.body[customerSchema.primary_key]).toBeDefined()
			expect(result.body.companyName).toBeDefined()
			expect(result.body.contactName).toBeDefined()
			customers.push(result.body)
		})
		it('Create Many', async function () {
			const result = await request(app.getHttpServer())
				.post(`/Customer/`)
				.send([customerTestingService.mockCustomer(userId), customerTestingService.mockCustomer(userId)])
				.set('Authorization', `Bearer ${jwt}`)
				.expect(201)
			expect(result.body).toBeDefined()
			expect(result.body.total).toBeDefined()
			expect(result.body.total).toEqual(2)
			expect(result.body.errored).toBeDefined()
			expect(result.body.errored).toEqual(0)
			expect(result.body.successful).toBeDefined()
			expect(result.body.successful).toEqual(2)
			expect(result.body.data.length).toBeGreaterThan(0)
			expect(result.body.data[0][customerSchema.primary_key]).toBeDefined()
			expect(result.body.data[0].companyName).toBeDefined()
			expect(result.body.data[1][customerSchema.primary_key]).toBeDefined()
			expect(result.body.data[1].companyName).toBeDefined()
			customers.push(result.body.data[0])
			customers.push(result.body.data[1])
		})
	})

	describe('Public Creation', () => {
		it('Default public fail to create', async function () {
			await request(app.getHttpServer())
				.post(`/Customer/`)
				.send(customerTestingService.mockCustomer(userId))
				.expect(401)
		})

		it('Cannot create with READ permissions', async function () {
			const public_table_record = await authTestingService.createPublicTablesRecord({
				table: customerSchema.table,
				access_level: RolePermission.READ,
			})

			try {
				await request(app.getHttpServer())
					.post(`/Customer/`)
					.send(customerTestingService.mockCustomer(userId))
					.expect(401)
			} catch (e) {
				logger.error(e)
				throw e
			} finally {
				await authTestingService.deletePublicTablesRecord(public_table_record)
			}
		})

		it('Can create with WRITE permissions', async function () {
			const public_table_record = await authTestingService.createPublicTablesRecord({
				table: customerSchema.table,
				access_level: RolePermission.WRITE,
			})

			try {
				const result = await request(app.getHttpServer())
					.post(`/Customer/`)
					.send(customerTestingService.mockCustomer(userId))
					.expect(201)

				expect(result.body).toBeDefined()
				expect(result.body[customerSchema.primary_key]).toBeDefined()
				expect(result.body.companyName).toBeDefined()
				expect(result.body.contactName).toBeDefined()
				customers.push(result.body)
			} catch (e) {
				logger.error(e)
				throw e
			} finally {
				await authTestingService.deletePublicTablesRecord(public_table_record)
			}
		})
	})

	//TODO test multiple records with different permissions
	describe('Role Based Creation', () => {
		it('No table role, creates record', async function () {
			const result = await request(app.getHttpServer())
				.post(`/Customer/`)
				.send(customerTestingService.mockCustomer(userId))
				.set('Authorization', `Bearer ${jwt}`)
				.expect(201)
			customers.push(result.body)
		})

		it('DELETE table role, creates record', async function () {
			const role = await authTestingService.createRole({
				custom: true,
				table: customerSchema.table,
				identity_column: 'userId',
				role: 'ADMIN',
				records: RolePermission.DELETE,
				own_records: RolePermission.DELETE,
			})

			try {
				const result = await request(app.getHttpServer())
					.post(`/Customer/`)
					.send(customerTestingService.mockCustomer(userId))
					.set('Authorization', `Bearer ${jwt}`)
					.expect(201)
				customers.push(result.body)
			} catch (e) {
				logger.error(e)
				throw e
			} finally {
				await authTestingService.deleteRole(role)
			}
		})

		it('DELETE table role, own records, creates own record', async function () {
			const role = await authTestingService.createRole({
				custom: true,
				table: customerSchema.table,
				identity_column: 'userId',
				role: 'ADMIN',
				records: RolePermission.NONE,
				own_records: RolePermission.DELETE,
			})

			try {
				const result = await request(app.getHttpServer())
					.post(`/Customer/`)
					.send(customerTestingService.mockCustomer(userId))
					.set('Authorization', `Bearer ${jwt}`)
					.expect(201)
				customers.push(result.body)
			} catch (e) {
				logger.error(e)
				throw e
			} finally {
				await authTestingService.deleteRole(role)
			}
		})

		it('DELETE table role, own records, fails to create someone elses record', async function () {
			const role = await authTestingService.createRole({
				custom: true,
				table: customerSchema.table,
				identity_column: 'userId',
				role: 'ADMIN',
				records: RolePermission.NONE,
				own_records: RolePermission.DELETE,
			})

			try {
				await request(app.getHttpServer())
					.post(`/Customer/`)
					.send(customerTestingService.mockCustomer(user[userSchema.primary_key]))
					.set('Authorization', `Bearer ${jwt}`)
					.expect(401)
			} catch (e) {
				logger.error(e)
				throw e
			} finally {
				await authTestingService.deleteRole(role)
			}
		})

		it('WRITE table role, creates record', async function () {
			const role = await authTestingService.createRole({
				custom: true,
				table: customerSchema.table,
				identity_column: 'userId',
				role: 'ADMIN',
				records: RolePermission.WRITE,
				own_records: RolePermission.WRITE,
			})

			try {
				const result = await request(app.getHttpServer())
					.post(`/Customer/`)
					.send(customerTestingService.mockCustomer(userId))
					.set('Authorization', `Bearer ${jwt}`)
					.expect(201)
				customers.push(result.body)
			} catch (e) {
				logger.error(e)
				throw e
			} finally {
				await authTestingService.deleteRole(role)
			}
		})

		it('WRITE table role, own records, creates own record', async function () {
			const role = await authTestingService.createRole({
				custom: true,
				table: customerSchema.table,
				identity_column: 'userId',
				role: 'ADMIN',
				records: RolePermission.NONE,
				own_records: RolePermission.WRITE,
			})

			try {
				const result = await request(app.getHttpServer())
					.post(`/Customer/`)
					.send(customerTestingService.mockCustomer(userId))
					.set('Authorization', `Bearer ${jwt}`)
					.expect(201)
				customers.push(result.body)
			} catch (e) {
				logger.error(e)
				throw e
			} finally {
				await authTestingService.deleteRole(role)
			}
		})

		it('WRITE table role, own records, fails to create someone elses record', async function () {
			const role = await authTestingService.createRole({
				custom: true,
				table: customerSchema.table,
				identity_column: 'userId',
				role: 'ADMIN',
				records: RolePermission.NONE,
				own_records: RolePermission.WRITE,
			})

			try {
				await request(app.getHttpServer())
					.post(`/Customer/`)
					.send(customerTestingService.mockCustomer(user[userSchema.primary_key]))
					.set('Authorization', `Bearer ${jwt}`)
					.expect(401)
			} catch (e) {
				logger.error(e)
				throw e
			} finally {
				await authTestingService.deleteRole(role)
			}
		})

		it('READ table role, cannot create', async function () {
			const role = await authTestingService.createRole({
				custom: true,
				table: customerSchema.table,
				identity_column: 'userId',
				role: 'ADMIN',
				records: RolePermission.READ,
				own_records: RolePermission.READ,
			})

			try {
				await request(app.getHttpServer())
					.post(`/Customer/`)
					.send(customerTestingService.mockCustomer(userId))
					.set('Authorization', `Bearer ${jwt}`)
					.expect(401)
			} catch (e) {
				logger.error(e)
				throw e
			} finally {
				await authTestingService.deleteRole(role)
			}
		})

		it('READ table role, own records, cannot create own record', async function () {
			const role = await authTestingService.createRole({
				custom: true,
				table: customerSchema.table,
				identity_column: 'userId',
				role: 'ADMIN',
				records: RolePermission.NONE,
				own_records: RolePermission.READ,
			})

			try {
				await request(app.getHttpServer())
					.post(`/Customer/`)
					.send(customerTestingService.mockCustomer(userId))
					.set('Authorization', `Bearer ${jwt}`)
					.expect(401)
			} catch (e) {
				logger.error(e)
				throw e
			} finally {
				await authTestingService.deleteRole(role)
			}
		})

		it('READ table role, own records, fails to create someone elses record', async function () {
			const role = await authTestingService.createRole({
				custom: true,
				table: customerSchema.table,
				identity_column: 'userId',
				role: 'ADMIN',
				records: RolePermission.NONE,
				own_records: RolePermission.READ,
			})

			try {
				await request(app.getHttpServer())
					.post(`/Customer/`)
					.send(customerTestingService.mockCustomer(user[userSchema.primary_key]))
					.set('Authorization', `Bearer ${jwt}`)
					.expect(401)
			} catch (e) {
				logger.error(e)
				throw e
			} finally {
				await authTestingService.deleteRole(role)
			}
		})
	})

	//TODO test multiple records results
	describe('Allowed Fields Results', () => {
		it('As standard, all fields returned', async function () {
			const result = await request(app.getHttpServer())
				.post(`/Customer/`)
				.send(customerTestingService.mockCustomer(userId))
				.set('Authorization', `Bearer ${jwt}`)
				.expect(201)
			customers.push(result.body)

			expect(result.body).toBeDefined()
			expect(result.body[customerSchema.primary_key]).toBeDefined()
			expect(result.body.companyName).toBeDefined()
			expect(result.body.contactName).toBeDefined()
			expect(result.body.contactTitle).toBeDefined()
			expect(result.body.address).toBeDefined()
			expect(result.body.city).toBeDefined()
			expect(result.body.region).toBeDefined()
			expect(result.body.postalCode).toBeDefined()
			expect(result.body.country).toBeDefined()
			expect(result.body.phone).toBeDefined()
			expect(result.body.fax).toBeDefined()
		})

		it('When allowed_fields are passed, only return these fields', async function () {
			const role = await authTestingService.createRole({
				custom: true,
				table: customerSchema.table,
				identity_column: 'userId',
				role: 'ADMIN',
				records: RolePermission.WRITE,
				own_records: RolePermission.WRITE,
				allowed_fields: 'companyName,contactName',
			})

			try {
				const result = await request(app.getHttpServer())
					.post(`/Customer/`)
					.send(customerTestingService.mockCustomer(userId))
					.set('Authorization', `Bearer ${jwt}`)
					.expect(201)
				customers.push(result.body)
				expect(result.body).toBeDefined()
				expect(result.body[customerSchema.primary_key]).toBeUndefined()
				expect(result.body.companyName).toBeDefined()
				expect(result.body.contactName).toBeDefined()
				expect(result.body.contactTitle).toBeUndefined()
				expect(result.body.address).toBeUndefined()
				expect(result.body.city).toBeUndefined()
				expect(result.body.region).toBeUndefined()
				expect(result.body.postalCode).toBeUndefined()
				expect(result.body.country).toBeUndefined()
				expect(result.body.phone).toBeUndefined()
				expect(result.body.fax).toBeUndefined()
			} catch (e) {
				logger.error(e)
				throw e
			} finally {
				await authTestingService.deleteRole(role)
			}
		})
	})

	afterAll(async () => {
		for (let customer of customers) {
			await customerTestingService.deleteCustomer(customer[customerSchema.primary_key])
		}
		await userTestingService.deleteUser(user[userSchema.primary_key])
		await app.close()
	})
})

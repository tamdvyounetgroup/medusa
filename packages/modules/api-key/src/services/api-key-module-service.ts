import {
  ApiKeyTypes,
  Context,
  DAL,
  FilterableApiKeyProps,
  FindConfig,
  IApiKeyModuleService,
  InternalModuleDeclaration,
  ModuleJoinerConfig,
  ModulesSdkTypes,
} from "@medusajs/framework/types"
import {
  ApiKeyType,
  InjectManager,
  InjectTransactionManager,
  isObject,
  isPresent,
  isString,
  MedusaContext,
  MedusaError,
  MedusaService,
  promiseAll,
} from "@medusajs/framework/utils"
import { ApiKey } from "@models"
import {
  CreateApiKeyDTO,
  RevokeApiKeyInput,
  TokenDTO,
  UpdateApiKeyInput,
} from "@types"
import crypto from "crypto"
import util from "util"
import { joinerConfig } from "../joiner-config"

const scrypt = util.promisify(crypto.scrypt)

type InjectedDependencies = {
  baseRepository: DAL.RepositoryService
  apiKeyService: ModulesSdkTypes.IMedusaInternalService<any>
}

export class ApiKeyModuleService
  extends MedusaService<{
    ApiKey: { dto: ApiKeyTypes.ApiKeyDTO }
  }>({ ApiKey })
  implements IApiKeyModuleService
{
  protected baseRepository_: DAL.RepositoryService
  protected readonly apiKeyService_: ModulesSdkTypes.IMedusaInternalService<ApiKey>

  constructor(
    { baseRepository, apiKeyService }: InjectedDependencies,
    protected readonly moduleDeclaration: InternalModuleDeclaration
  ) {
    // @ts-ignore
    super(...arguments)
    this.baseRepository_ = baseRepository
    this.apiKeyService_ = apiKeyService
  }

  __joinerConfig(): ModuleJoinerConfig {
    return joinerConfig
  }

  @InjectTransactionManager()
  // @ts-expect-error
  async deleteApiKeys(
    ids: string | string[],
    @MedusaContext() sharedContext: Context = {}
  ) {
    const apiKeyIds = Array.isArray(ids) ? ids : [ids]

    const unrevokedApiKeys = (
      await this.apiKeyService_.list(
        {
          id: ids,
          $or: [
            { revoked_at: { $eq: null } },
            { revoked_at: { $gt: new Date() } },
          ],
        },
        { select: ["id"] },
        sharedContext
      )
    ).map((apiKey) => apiKey.id)

    if (isPresent(unrevokedApiKeys)) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Cannot delete api keys that are not revoked - ${unrevokedApiKeys.join(
          ", "
        )}`
      )
    }

    return await super.deleteApiKeys(apiKeyIds, sharedContext)
  }

  //@ts-expect-error
  createApiKeys(
    data: ApiKeyTypes.CreateApiKeyDTO[],
    sharedContext?: Context
  ): Promise<ApiKeyTypes.ApiKeyDTO[]>
  createApiKeys(
    data: ApiKeyTypes.CreateApiKeyDTO,
    sharedContext?: Context
  ): Promise<ApiKeyTypes.ApiKeyDTO>

  @InjectManager()
  async createApiKeys(
    data: ApiKeyTypes.CreateApiKeyDTO | ApiKeyTypes.CreateApiKeyDTO[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<ApiKeyTypes.ApiKeyDTO | ApiKeyTypes.ApiKeyDTO[]> {
    const [createdApiKeys, generatedTokens] = await this.createApiKeys_(
      Array.isArray(data) ? data : [data],
      sharedContext
    )

    const serializedResponse = await this.baseRepository_.serialize<
      ApiKeyTypes.ApiKeyDTO[]
    >(createdApiKeys, {
      populate: true,
    })

    // When creating we want to return the raw token, as this will be the only time the user will be able to take note of it for future use.
    const responseWithRawToken = serializedResponse.map((key) => ({
      ...key,
      token:
        generatedTokens.find((t) => t.hashedToken === key.token)?.rawToken ??
        key.token,
      salt: undefined,
    }))

    return Array.isArray(data) ? responseWithRawToken : responseWithRawToken[0]
  }

  @InjectTransactionManager()
  protected async createApiKeys_(
    data: ApiKeyTypes.CreateApiKeyDTO[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<[ApiKey[], TokenDTO[]]> {
    await this.validateCreateApiKeys_(data, sharedContext)

    const normalizedInput: CreateApiKeyDTO[] = []
    const generatedTokens: TokenDTO[] = []
    for (const key of data) {
      let tokenData: TokenDTO
      if (key.type === ApiKeyType.PUBLISHABLE) {
        tokenData = ApiKeyModuleService.generatePublishableKey()
      } else {
        tokenData = await ApiKeyModuleService.generateSecretKey()
      }

      generatedTokens.push(tokenData)
      normalizedInput.push({
        ...key,
        token: tokenData.hashedToken,
        salt: tokenData.salt,
        redacted: tokenData.redacted,
      })
    }

    const createdApiKeys = await this.apiKeyService_.create(
      normalizedInput,
      sharedContext
    )

    return [createdApiKeys, generatedTokens]
  }

  async upsertApiKeys(
    data: ApiKeyTypes.UpsertApiKeyDTO[],
    sharedContext?: Context
  ): Promise<ApiKeyTypes.ApiKeyDTO[]>
  async upsertApiKeys(
    data: ApiKeyTypes.UpsertApiKeyDTO,
    sharedContext?: Context
  ): Promise<ApiKeyTypes.ApiKeyDTO>

  @InjectManager()
  async upsertApiKeys(
    data: ApiKeyTypes.UpsertApiKeyDTO | ApiKeyTypes.UpsertApiKeyDTO[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<ApiKeyTypes.ApiKeyDTO | ApiKeyTypes.ApiKeyDTO[]> {
    const input = Array.isArray(data) ? data : [data]
    const forUpdate = input.filter(
      (apiKey): apiKey is UpdateApiKeyInput => !!apiKey.id
    )
    const forCreate = input.filter(
      (apiKey): apiKey is ApiKeyTypes.CreateApiKeyDTO => !apiKey.id
    )

    const operations: Promise<ApiKeyTypes.ApiKeyDTO[]>[] = []

    if (forCreate.length) {
      const op = async () => {
        const [createdApiKeys, generatedTokens] = await this.createApiKeys_(
          forCreate,
          sharedContext
        )
        const serializedResponse = await this.baseRepository_.serialize<
          ApiKeyTypes.ApiKeyDTO[]
        >(createdApiKeys, {
          populate: true,
        })

        return serializedResponse.map(
          (key) =>
            ({
              ...key,
              token:
                generatedTokens.find((t) => t.hashedToken === key.token)
                  ?.rawToken ?? key.token,
              salt: undefined,
            } as ApiKeyTypes.ApiKeyDTO)
        )
      }

      operations.push(op())
    }

    if (forUpdate.length) {
      const op = async () => {
        const updateResp = await this.updateApiKeys_(forUpdate, sharedContext)
        return await this.baseRepository_.serialize<ApiKeyTypes.ApiKeyDTO[]>(
          updateResp
        )
      }

      operations.push(op())
    }

    const result = (await promiseAll(operations)).flat()
    return Array.isArray(data) ? result : result[0]
  }

  //@ts-expect-error
  async updateApiKeys(
    id: string,
    data: ApiKeyTypes.UpdateApiKeyDTO,
    sharedContext?: Context
  ): Promise<ApiKeyTypes.ApiKeyDTO>
  async updateApiKeys(
    selector: FilterableApiKeyProps,
    data: ApiKeyTypes.UpdateApiKeyDTO,
    sharedContext?: Context
  ): Promise<ApiKeyTypes.ApiKeyDTO[]>

  @InjectManager()
  async updateApiKeys(
    idOrSelector: string | FilterableApiKeyProps,
    data: ApiKeyTypes.UpdateApiKeyDTO,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<ApiKeyTypes.ApiKeyDTO[] | ApiKeyTypes.ApiKeyDTO> {
    let normalizedInput = await this.normalizeUpdateInput_<UpdateApiKeyInput>(
      idOrSelector,
      data,
      sharedContext
    )

    const updatedApiKeys = await this.updateApiKeys_(
      normalizedInput,
      sharedContext
    )

    const serializedResponse = await this.baseRepository_.serialize<
      ApiKeyTypes.ApiKeyDTO[]
    >(updatedApiKeys.map(omitToken), {
      populate: true,
    })

    return isString(idOrSelector) ? serializedResponse[0] : serializedResponse
  }

  @InjectTransactionManager()
  protected async updateApiKeys_(
    normalizedInput: UpdateApiKeyInput[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<ApiKey[]> {
    const updateRequest = normalizedInput.map((k) => ({
      id: k.id,
      title: k.title,
    }))

    const updatedApiKeys = await this.apiKeyService_.update(
      updateRequest,
      sharedContext
    )
    return updatedApiKeys
  }

  @InjectManager()
  // @ts-expect-error
  async retrieveApiKey(
    id: string,
    config?: FindConfig<ApiKeyTypes.ApiKeyDTO>,
    sharedContext?: Context
  ): Promise<ApiKeyTypes.ApiKeyDTO> {
    const apiKey = await this.apiKeyService_.retrieve(id, config, sharedContext)

    return await this.baseRepository_.serialize<ApiKeyTypes.ApiKeyDTO>(
      omitToken(apiKey),
      {
        populate: true,
      }
    )
  }

  @InjectManager()
  //@ts-expect-error
  async listApiKeys(
    filters?: ApiKeyTypes.FilterableApiKeyProps,
    config?: FindConfig<ApiKeyTypes.ApiKeyDTO>,
    sharedContext?: Context
  ): Promise<ApiKeyTypes.ApiKeyDTO[]> {
    const apiKeys = await this.apiKeyService_.list(
      filters,
      config,
      sharedContext
    )

    return await this.baseRepository_.serialize<ApiKeyTypes.ApiKeyDTO[]>(
      apiKeys.map(omitToken),
      {
        populate: true,
      }
    )
  }

  @InjectManager()
  //@ts-expect-error
  async listAndCountApiKeys(
    filters?: ApiKeyTypes.FilterableApiKeyProps,
    config?: FindConfig<ApiKeyTypes.ApiKeyDTO>,
    sharedContext?: Context
  ): Promise<[ApiKeyTypes.ApiKeyDTO[], number]> {
    const [apiKeys, count] = await this.apiKeyService_.listAndCount(
      filters,
      config,
      sharedContext
    )

    return [
      await this.baseRepository_.serialize<ApiKeyTypes.ApiKeyDTO[]>(
        apiKeys.map(omitToken),
        {
          populate: true,
        }
      ),
      count,
    ]
  }

  async revoke(
    id: string,
    data: ApiKeyTypes.RevokeApiKeyDTO,
    sharedContext?: Context
  ): Promise<ApiKeyTypes.ApiKeyDTO>
  async revoke(
    selector: FilterableApiKeyProps,
    data: ApiKeyTypes.RevokeApiKeyDTO,
    sharedContext?: Context
  ): Promise<ApiKeyTypes.ApiKeyDTO[]>
  @InjectManager()
  async revoke(
    idOrSelector: string | FilterableApiKeyProps,
    data: ApiKeyTypes.RevokeApiKeyDTO,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<ApiKeyTypes.ApiKeyDTO[] | ApiKeyTypes.ApiKeyDTO> {
    const normalizedInput = await this.normalizeUpdateInput_<RevokeApiKeyInput>(
      idOrSelector,
      data,
      sharedContext
    )
    const revokedApiKeys = await this.revoke_(normalizedInput, sharedContext)

    const serializedResponse = await this.baseRepository_.serialize<
      ApiKeyTypes.ApiKeyDTO[]
    >(revokedApiKeys.map(omitToken), {
      populate: true,
    })

    return isString(idOrSelector) ? serializedResponse[0] : serializedResponse
  }

  @InjectTransactionManager()
  async revoke_(
    normalizedInput: RevokeApiKeyInput[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<ApiKey[]> {
    await this.validateRevokeApiKeys_(normalizedInput)

    const updateRequest = normalizedInput.map((k) => {
      const revokedAt = new Date()
      if (k.revoke_in && k.revoke_in > 0) {
        revokedAt.setSeconds(revokedAt.getSeconds() + k.revoke_in)
      }

      return {
        id: k.id,
        revoked_at: revokedAt,
        revoked_by: k.revoked_by,
      }
    })

    const revokedApiKeys = await this.apiKeyService_.update(
      updateRequest,
      sharedContext
    )

    return revokedApiKeys
  }

  @InjectManager()
  async authenticate(
    token: string,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<ApiKeyTypes.ApiKeyDTO | false> {
    const result = await this.authenticate_(token, sharedContext)
    if (!result) {
      return false
    }

    const serialized =
      await this.baseRepository_.serialize<ApiKeyTypes.ApiKeyDTO>(result, {
        populate: true,
      })

    return serialized
  }

  @InjectTransactionManager()
  protected async authenticate_(
    token: string,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<ApiKey | false> {
    // Since we only allow up to 2 active tokens, getitng the list and checking each token isn't an issue.
    // We can always filter on the redacted key if we add support for an arbitrary number of tokens.
    const secretKeys = await this.apiKeyService_.list(
      {
        type: ApiKeyType.SECRET,
        // If the revoke date is set in the future, it means the key is still valid.
        $or: [
          { revoked_at: { $eq: null } },
          { revoked_at: { $gt: new Date() } },
        ],
      },
      {},
      sharedContext
    )

    const matches = await promiseAll(
      secretKeys.map(async (dbKey) => {
        const hashedInput = await ApiKeyModuleService.calculateHash(
          token,
          dbKey.salt
        )
        if (hashedInput === dbKey.token) {
          return dbKey
        }

        return undefined
      })
    )

    const matchedKeys = matches.filter((match) => !!match)
    if (!matchedKeys.length) {
      return false
    }
    return matchedKeys[0]!
  }

  protected async validateCreateApiKeys_(
    data: ApiKeyTypes.CreateApiKeyDTO[],
    sharedContext: Context = {}
  ): Promise<void> {
    if (!data.length) {
      return
    }

    // There can only be 2 secret keys at most, and one has to be with a revoked_at date set, so only 1 can be newly created.
    const secretKeysToCreate = data.filter((k) => k.type === ApiKeyType.SECRET)
    if (!secretKeysToCreate.length) {
      return
    }

    if (secretKeysToCreate.length > 1) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `You can only create one secret key at a time. You tried to create ${secretKeysToCreate.length} secret keys.`
      )
    }

    // There already is a key that is not set to expire/or it hasn't expired
    const dbSecretKeys = await this.apiKeyService_.list(
      {
        type: ApiKeyType.SECRET,
        $or: [
          { revoked_at: { $eq: null } },
          { revoked_at: { $gt: new Date() } },
        ],
      },
      {},
      sharedContext
    )

    if (dbSecretKeys.length) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `You can only have one active secret key a time. Revoke or delete your existing key before creating a new one.`
      )
    }
  }

  protected async normalizeUpdateInput_<T>(
    idOrSelector: string | FilterableApiKeyProps,
    data: Omit<T, "id">,
    sharedContext: Context = {}
  ): Promise<T[]> {
    let normalizedInput: T[] = []
    if (isString(idOrSelector)) {
      normalizedInput = [{ id: idOrSelector, ...data } as T]
    }

    if (isObject(idOrSelector)) {
      const apiKeys = await this.apiKeyService_.list(
        idOrSelector,
        {},
        sharedContext
      )

      normalizedInput = apiKeys.map(
        (apiKey) =>
          ({
            id: apiKey.id,
            ...data,
          } as T)
      )
    }

    return normalizedInput
  }

  protected async validateRevokeApiKeys_(
    data: RevokeApiKeyInput[],
    sharedContext: Context = {}
  ): Promise<void> {
    if (!data.length) {
      return
    }

    if (data.some((k) => !k.id)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `You must provide an api key id field when revoking a key.`
      )
    }

    if (data.some((k) => !k.revoked_by)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `You must provide a revoked_by field when revoking a key.`
      )
    }

    const revokedApiKeys = await this.apiKeyService_.list(
      {
        id: data.map((k) => k.id),
        type: ApiKeyType.SECRET,
        revoked_at: { $ne: null },
      },
      {},
      sharedContext
    )

    if (revokedApiKeys.length) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `There are ${revokedApiKeys.length} secret keys that are already revoked.`
      )
    }
  }

  // These are public keys, so there is no point hashing them.
  protected static generatePublishableKey(): TokenDTO {
    const token = "pk_" + crypto.randomBytes(32).toString("hex")

    return {
      rawToken: token,
      hashedToken: token,
      salt: "",
      redacted: redactKey(token),
    }
  }

  protected static async generateSecretKey(): Promise<TokenDTO> {
    const token = "sk_" + crypto.randomBytes(32).toString("hex")
    const salt = crypto.randomBytes(16).toString("hex")
    const hashed = await this.calculateHash(token, salt)

    return {
      rawToken: token,
      hashedToken: hashed,
      salt,
      redacted: redactKey(token),
    }
  }

  protected static async calculateHash(
    token: string,
    salt: string
  ): Promise<string> {
    return ((await scrypt(token, salt, 64)) as Buffer).toString("hex")
  }
}

// We are mutating the object here as what microORM relies on non-enumerable fields for serialization, among other things.
const omitToken = (
  // We have to make salt optional before deleting it (and we do want it required in the DB)
  key: Omit<ApiKey, "salt"> & { salt?: string }
): Omit<ApiKey, "salt"> => {
  key.token = key.type === ApiKeyType.SECRET ? "" : key.token
  delete key.salt
  return key
}

const redactKey = (key: string): string => {
  return [key.slice(0, 6), key.slice(-3)].join("***")
}

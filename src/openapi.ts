// ── OpenAPI 3.0 Specification ──────────────────────────────────────────
// Uncounted Backend API - 전체 엔드포인트 문서화
//
// 암호화 참고사항:
//   - 요청 바디: 이 문서는 plaintext 스키마를 보여줍니다.
//     실제 요청 시 POST/PUT/PATCH/DELETE body는 AES-256-GCM으로 암호화해야 합니다.
//     형식: base64url(IV[12B] | AuthTag[16B] | Ciphertext)
//   - 응답 필드: id, token, email, text 등 민감 필드는 암호화된 문자열로 반환됩니다.
//     형식: <encrypted>@enc_uncounted (type: string, format: encrypted-string)

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Uncounted API',
    version: '1.0.0',
    description: `Uncounted Backend API — Supabase 기반 인증, 세션, 스토리지, 어드민, 로그, 전사 데이터 관리

## 암호화 정책

### 요청 바디 (POST / PUT / DELETE)
\`/api/*\` 경로의 모든 요청 바디는 **AES-256-GCM** 암호화가 필요합니다.

\`\`\`
형식: base64url(IV[12B] | AuthTag[16B] | Ciphertext)
\`\`\`

이 Swagger UI는 plaintext 스키마를 표시합니다. "Try it out"은 암호화를 적용하지 않으므로 실제 요청 테스트에는 클라이언트 암호화 유틸리티를 사용하세요.

### 응답 필드
\`id\`, \`token\`, \`email\`, \`text\` 등 민감 정보는 암호화된 문자열로 반환됩니다.

\`\`\`
형식: <encrypted_value>@enc_uncounted
\`\`\`

### 인증
- **Bearer Token**: \`Authorization: Bearer <access_token>\`
- **Cookie**: \`uncounted_session\` (httpOnly, 1시간 만료)`,
  },
  servers: [
    {
      url: 'http://localhost:3001',
      description: 'Local Development',
    },
  ],
  tags: [
    { name: 'health', description: '헬스 체크' },
    { name: 'auth', description: '인증 (로그인, 회원가입, 세션 관리)' },
    { name: 'sessions', description: '세션 CRUD (인증 필요)' },
    { name: 'storage', description: '파일 스토리지 (인증 필요)' },
    { name: 'admin', description: '관리자 API (인증 필요)' },
    { name: 'logging', description: '이벤트/에러 로그 (인증 선택)' },
    { name: 'transcripts', description: 'STT 전사 데이터 (인증 필요)' },
    { name: 'transcript-chunks', description: '청크별 전사 + 오디오 통계 (인증 필요)' },
    { name: 'session-chunks', description: '청크별 세션 라벨 (인증 필요)' },
    { name: 'user', description: '사용자 프로필/동의 관리 (인증 필요)' },
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Supabase JWT access token',
      },
      CookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'uncounted_session',
        description: 'httpOnly 쿠키 세션 (로그인 후 자동 설정)',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', description: '에러 메시지' },
        },
        required: ['error'],
      },
      Success: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
            },
          },
        },
      },
      EncryptedString: {
        type: 'string',
        format: 'encrypted-string',
        description: '암호화된 문자열. 형식: `<value>@enc_uncounted`',
        example: 'abc123xyz@enc_uncounted',
      },
      Session: {
        type: 'object',
        description: '세션 객체 (응답). 민감 필드는 암호화됩니다.',
        properties: {
          id: { $ref: '#/components/schemas/EncryptedString' },
          title: { type: 'string' },
          date: { type: 'string', format: 'date-time' },
          duration: { type: 'number', description: '초 단위' },
          qaScore: { type: 'number' },
          contributionScore: { type: 'number' },
          labels: { type: 'object', nullable: true },
          strategyLocked: { type: 'boolean' },
          assetType: { type: 'string', example: '업무/회의' },
          isPublic: { type: 'boolean' },
          visibilityStatus: {
            type: 'string',
            enum: ['PRIVATE', 'PUBLIC', 'REVIEW'],
          },
          visibilitySource: { type: 'string', enum: ['MANUAL', 'AUTO'] },
          visibilityConsentVersion: { type: 'string', nullable: true },
          visibilityChangedAt: { type: 'string', format: 'date-time', nullable: true },
          status: { type: 'string', enum: ['uploaded', 'processing', 'done', 'error'] },
          isPiiCleaned: { type: 'boolean' },
          hasDiarization: { type: 'boolean' },
          chunkCount: { type: 'integer' },
          audioUrl: { $ref: '#/components/schemas/EncryptedString' },
          callRecordId: { $ref: '#/components/schemas/EncryptedString' },
          dupStatus: { type: 'string', enum: ['none', 'duplicate', 'representative'] },
          dupGroupId: { $ref: '#/components/schemas/EncryptedString' },
          dupConfidence: { type: 'number', nullable: true },
          fileHashSha256: { $ref: '#/components/schemas/EncryptedString' },
          audioFingerprint: { $ref: '#/components/schemas/EncryptedString' },
          dupRepresentative: { type: 'boolean', nullable: true },
          uploadStatus: { type: 'string', enum: ['LOCAL', 'UPLOADED', 'FAILED'] },
          piiStatus: { type: 'string', enum: ['CLEAR', 'PENDING', 'FLAGGED'] },
          shareScope: { type: 'string', enum: ['PRIVATE', 'PUBLIC', 'TEAM'] },
          eligibleForShare: { type: 'boolean' },
          reviewAction: { type: 'string', nullable: true },
          lockReason: { type: 'object', nullable: true },
          lockStartMs: { type: 'number', nullable: true },
          lockEndMs: { type: 'number', nullable: true },
          localSanitizedWavPath: { $ref: '#/components/schemas/EncryptedString' },
          localSanitizedTextPreview: { $ref: '#/components/schemas/EncryptedString' },
          consentStatus: { type: 'string', enum: ['locked', 'consented', 'both_agreed', 'denied'] },
          consentedAt: { type: 'string', format: 'date-time', nullable: true },
          verifiedSpeaker: { type: 'boolean' },
          userId: { $ref: '#/components/schemas/EncryptedString' },
          peerId: { $ref: '#/components/schemas/EncryptedString' },
          labelStatus: { type: 'string', nullable: true },
          labelSource: { type: 'string', nullable: true },
          labelConfidence: { type: 'number', nullable: true },
        },
      },
      SessionInput: {
        type: 'object',
        description: '세션 입력 객체 (요청). plaintext ID 사용.',
        required: ['id', 'title', 'date', 'duration'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          date: { type: 'string', format: 'date-time' },
          duration: { type: 'number' },
          qaScore: { type: 'number' },
          contributionScore: { type: 'number' },
          labels: { type: 'object', nullable: true },
          strategyLocked: { type: 'boolean' },
          assetType: { type: 'string' },
          isPublic: { type: 'boolean' },
          visibilityStatus: { type: 'string' },
          visibilitySource: { type: 'string' },
          status: { type: 'string' },
          uploadStatus: { type: 'string' },
          chunkCount: { type: 'integer' },
        },
      },
      Transcript: {
        type: 'object',
        properties: {
          sessionId: { $ref: '#/components/schemas/EncryptedString' },
          text: { $ref: '#/components/schemas/EncryptedString' },
          summary: { $ref: '#/components/schemas/EncryptedString' },
          words: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                word: { type: 'string' },
                start: { type: 'number' },
                end: { type: 'number' },
                probability: { type: 'number' },
              },
            },
          },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  security: [{ BearerAuth: [] }, { CookieAuth: [] }],
  paths: {
    // ── Health ──────────────────────────────────────────────────────────
    '/': {
      get: {
        tags: ['health'],
        summary: '서비스 상태 확인',
        security: [],
        responses: {
          200: {
            description: '서비스 정보',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    service: { type: 'string', example: 'Uncounted Backend API' },
                    version: { type: 'string', example: '1.0.0' },
                    status: { type: 'string', example: 'healthy' },
                    timestamp: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/health': {
      get: {
        tags: ['health'],
        summary: '헬스 체크',
        security: [],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ── Auth ────────────────────────────────────────────────────────────
    '/api/auth/signin': {
      post: {
        tags: ['auth'],
        summary: '이메일/비밀번호 로그인',
        description:
          '로그인 성공 시 `uncounted_session` (1h) 및 `uncounted_refresh` (90d) httpOnly 쿠키가 설정됩니다.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', format: 'password' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '로그인 성공',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        session: {
                          type: 'object',
                          properties: {
                            access_token: { $ref: '#/components/schemas/EncryptedString' },
                            refresh_token: { $ref: '#/components/schemas/EncryptedString' },
                          },
                        },
                        user: {
                          type: 'object',
                          properties: {
                            id: { $ref: '#/components/schemas/EncryptedString' },
                            email: { $ref: '#/components/schemas/EncryptedString' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          400: { description: '필수 파라미터 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 실패', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/auth/signup': {
      post: {
        tags: ['auth'],
        summary: '회원가입',
        description: '이메일 확인 없이 즉시 계정 생성.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', format: 'password', minLength: 6 },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '회원가입 성공',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        user: {
                          type: 'object',
                          properties: {
                            id: { $ref: '#/components/schemas/EncryptedString' },
                            email: { $ref: '#/components/schemas/EncryptedString' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          400: { description: '이미 존재하는 이메일 또는 유효성 오류', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/auth/signout': {
      post: {
        tags: ['auth'],
        summary: '로그아웃',
        description: '쿠키 삭제 및 Supabase 세션 무효화. 토큰 없어도 성공 반환.',
        responses: {
          200: {
            description: '로그아웃 성공',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' },
              },
            },
          },
        },
      },
    },
    '/api/auth/session': {
      get: {
        tags: ['auth'],
        summary: '현재 세션 조회',
        description: 'Authorization 헤더의 Bearer 토큰으로 세션 정보 반환.',
        responses: {
          200: {
            description: '세션 정보 (토큰 없으면 session: null)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        session: {
                          nullable: true,
                          type: 'object',
                          properties: {
                            access_token: { $ref: '#/components/schemas/EncryptedString' },
                            user: {
                              type: 'object',
                              properties: {
                                id: { $ref: '#/components/schemas/EncryptedString' },
                                email: { $ref: '#/components/schemas/EncryptedString' },
                              },
                            },
                          },
                        },
                      },
                    },
                    error: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['auth'],
        summary: 'OAuth 콜백 토큰 저장',
        description:
          'OAuth 로그인 후 프론트엔드에서 받은 토큰을 서버 쿠키로 저장.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['access_token', 'refresh_token'],
                properties: {
                  access_token: { type: 'string' },
                  refresh_token: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '토큰 저장 및 쿠키 설정 성공',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        session: {
                          type: 'object',
                          properties: {
                            access_token: { $ref: '#/components/schemas/EncryptedString' },
                            user: {
                              type: 'object',
                              properties: {
                                id: { $ref: '#/components/schemas/EncryptedString' },
                                email: { $ref: '#/components/schemas/EncryptedString' },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          400: { description: '파라미터 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '유효하지 않은 토큰', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/auth/me': {
      get: {
        tags: ['auth'],
        summary: '현재 사용자 조회',
        responses: {
          200: {
            description: '사용자 정보',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        user: {
                          type: 'object',
                          properties: {
                            id: { $ref: '#/components/schemas/EncryptedString' },
                            email: { $ref: '#/components/schemas/EncryptedString' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/auth/refresh': {
      post: {
        tags: ['auth'],
        summary: '액세스 토큰 갱신',
        description:
          '리프레시 토큰으로 새 액세스 토큰 발급. body 또는 `uncounted_refresh` 쿠키에서 읽음.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        security: [],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  refresh_token: { type: 'string', description: '쿠키가 없을 때 body에 포함' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '토큰 갱신 성공',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        session: {
                          type: 'object',
                          properties: {
                            access_token: { $ref: '#/components/schemas/EncryptedString' },
                            refresh_token: { $ref: '#/components/schemas/EncryptedString' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          400: { description: '리프레시 토큰 없음', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '토큰 갱신 실패', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/auth/oauth/google': {
      get: {
        tags: ['auth'],
        summary: 'Google OAuth 시작',
        description: 'Google 로그인 페이지로 리다이렉트합니다.\n\n- **웹 플로우**: `code_challenge` 없이 호출하면 서버에서 PKCE 생성 후 `pkce_flow_id` 쿠키로 관리합니다.\n- **네이티브 플로우**: 클라이언트가 직접 생성한 `code_challenge`를 전달합니다.',
        security: [],
        parameters: [
          {
            name: 'redirect',
            in: 'query',
            description: 'OAuth 완료 후 리다이렉트 URL',
            schema: { type: 'string', example: 'http://localhost:5173/auth' },
          },
          {
            name: 'code_challenge',
            in: 'query',
            description: 'PKCE code_challenge (S256). 네이티브 플로우에서 클라이언트가 직접 생성한 값 전달. 웹 플로우에서는 생략.',
            schema: { type: 'string' },
          },
        ],
        responses: {
          302: { description: 'Google 로그인 페이지로 리다이렉트' },
          500: { description: 'OAuth URL 생성 실패', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/auth/oauth/callback': {
      get: {
        tags: ['auth'],
        summary: 'Google OAuth 콜백',
        description: 'Supabase OAuth 인증 완료 후 리다이렉트되는 콜백 엔드포인트입니다. PKCE 코드 교환 후 `uncounted_session` 및 `uncounted_refresh` 쿠키를 설정합니다.\n\n- **웹 플로우**: `pkce_flow_id` 쿠키로 서버 저장 code_verifier 조회\n- **네이티브 플로우**: `code_verifier` 쿼리 파라미터로 직접 전달',
        security: [],
        parameters: [
          {
            name: 'code',
            in: 'query',
            required: true,
            description: 'Supabase OAuth 인증 코드',
            schema: { type: 'string' },
          },
          {
            name: 'code_verifier',
            in: 'query',
            description: 'PKCE code_verifier (네이티브 플로우에서만 전달)',
            schema: { type: 'string' },
          },
          {
            name: 'error',
            in: 'query',
            description: 'OAuth 오류 코드 (실패 시)',
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: {
            description: '인증 완료 및 쿠키 설정',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        session: {
                          type: 'object',
                          properties: {
                            access_token: { $ref: '#/components/schemas/EncryptedString' },
                            refresh_token: { $ref: '#/components/schemas/EncryptedString' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          400: { description: 'OAuth 오류 또는 파라미터 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/auth/link-pid': {
      post: {
        tags: ['auth'],
        summary: 'Pseudo ID 연결',
        description:
          '익명 사용자의 Pseudo ID를 인증된 User ID에 연결합니다.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['pid'],
                properties: {
                  pid: { type: 'string', description: 'Pseudo ID (익명 사용자 식별자)' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: '연결 성공', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          400: { description: 'pid 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Sessions ────────────────────────────────────────────────────────
    '/api/sessions': {
      get: {
        tags: ['sessions'],
        summary: '세션 목록 조회',
        description: '인증된 사용자의 세션 목록을 날짜 내림차순으로 반환합니다.',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 1000, maximum: 1000 } },
        ],
        responses: {
          200: {
            description: '세션 목록',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Session' } },
                    count: { type: 'integer' },
                    page: { type: 'integer' },
                    limit: { type: 'integer' },
                  },
                },
              },
            },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/sessions/batch': {
      post: {
        tags: ['sessions'],
        summary: '세션 일괄 upsert',
        description: '최대 500건의 세션을 한 번에 저장/업데이트합니다. `id` 충돌 시 업데이트.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['sessions'],
                properties: {
                  sessions: {
                    type: 'array',
                    maxItems: 500,
                    items: { $ref: '#/components/schemas/SessionInput' },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Upsert 완료',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Session' } },
                    count: { type: 'integer' },
                  },
                },
              },
            },
          },
          400: { description: '유효성 오류', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/sessions/{id}': {
      get: {
        tags: ['sessions'],
        summary: '세션 상세 조회',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: '세션 상세',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { $ref: '#/components/schemas/Session' } },
                },
              },
            },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: '세션 없음', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      patch: {
        tags: ['sessions'],
        summary: '세션 부분 수정 (STT 처리)',
        description: 'transcript, audio_metrics, upload_status를 개별 업데이트합니다. upload_status는 현재 값이 UPLOADED가 아닐 때만 변경됩니다.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  transcript: { type: 'string', description: '전사 텍스트' },
                  audio_metrics: { type: 'object', description: '오디오 메트릭' },
                  upload_status: { type: 'string', enum: ['LOCAL', 'UPLOADED', 'FAILED'] },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '수정 성공',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: { ok: { type: 'boolean' } } } } } } },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          500: { description: '서버 오류', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['sessions'],
        summary: '세션 삭제',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '삭제 성공', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/sessions/{id}/label-status': {
      put: {
        tags: ['sessions'],
        summary: '세션 레이블 상태 수정',
        description: '> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['label_status'],
                properties: {
                  label_status: { type: 'string', enum: ['AUTO', 'RECOMMENDED', 'REVIEW'] },
                  label_source: { type: 'string', description: 'auto | user | user_confirmed | multi_confirmed' },
                  label_confidence: { type: 'number', minimum: 0, maximum: 1 },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '수정 성공',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: { ok: { type: 'boolean' } } } } } } },
          },
          400: { description: '잘못된 요청', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/sessions/{id}/labels': {
      put: {
        tags: ['sessions'],
        summary: '세션 레이블 수정',
        description: '> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['labels'],
                properties: {
                  labels: { type: 'object', description: '레이블 데이터 (자유 형식 JSON)' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '수정된 세션',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Session' } } } } },
          },
          400: { description: '레이블 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: '세션 없음', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/sessions/{id}/visibility': {
      put: {
        tags: ['sessions'],
        summary: '세션 공개 여부 수정',
        description: '> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  isPublic: { type: 'boolean' },
                  visibilityStatus: { type: 'string', enum: ['PRIVATE', 'PUBLIC', 'REVIEW'] },
                  visibilitySource: { type: 'string', enum: ['MANUAL', 'AUTO'] },
                  visibilityConsentVersion: { type: 'string' },
                  visibilityChangedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '수정된 세션',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Session' } } } } },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: '세션 없음', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/api/sessions/{id}/diarization': {
      patch: {
        tags: ['sessions'],
        summary: '화자분리 상태 수정',
        description: '> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        security: [{ BearerAuth: [] }, { CookieAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['hasDiarization'],
                properties: {
                  hasDiarization: { type: 'boolean', description: '화자분리 완료 여부' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '수정 성공',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } },
          },
          400: { description: '잘못된 요청', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/api/sessions/{id}/dup': {
      patch: {
        tags: ['sessions'],
        summary: '중복 상태 수정',
        description: '클라이언트 중복 감지 결과를 반영합니다.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        security: [{ BearerAuth: [] }, { CookieAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['dupStatus'],
                properties: {
                  dupStatus: { type: 'string', enum: ['none', 'duplicate', 'representative'], description: '중복 상태' },
                  dupGroupId: { type: 'string', format: 'uuid', nullable: true, description: '중복 그룹 ID' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '수정 성공',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } },
          },
          400: { description: '잘못된 요청', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Storage ─────────────────────────────────────────────────────────
    '/api/storage/audio': {
      post: {
        tags: ['storage'],
        summary: 'WAV 오디오 업로드',
        description:
          'base64 인코딩된 WAV 파일을 `sanitized-audio` 버킷에 업로드합니다.\n저장 경로: `{userId}/{sessionId}.wav`\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['sessionId', 'wavData'],
                properties: {
                  sessionId: { type: 'string', format: 'uuid' },
                  wavData: { type: 'string', format: 'byte', description: 'base64 인코딩된 WAV 데이터' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '업로드 성공',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { path: { type: 'string', example: 'user-id/session-id.wav' } },
                },
              },
            },
          },
          400: { description: '파라미터 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/storage/meta': {
      post: {
        tags: ['storage'],
        summary: '메타데이터 JSONL 업로드',
        description:
          'JSONL 형식의 메타데이터를 `meta-jsonl` 버킷에 업로드합니다.\n저장 경로: `{userId}/{batchId}.jsonl`\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['batchId', 'content'],
                properties: {
                  batchId: { type: 'string', description: '배치 ID' },
                  content: { type: 'string', description: 'JSONL 형식의 텍스트 데이터' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '업로드 성공',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { path: { type: 'string' } },
                },
              },
            },
          },
          400: { description: '파라미터 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/storage/audio/signed-url': {
      post: {
        tags: ['storage'],
        summary: '오디오 서명 URL 발급',
        description:
          '비공개 버킷의 오디오 파일에 대한 시간 제한 접근 URL을 발급합니다.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['storagePath'],
                properties: {
                  storagePath: { type: 'string', description: 'Storage 경로 (예: userId/sessionId.wav)' },
                  expiresIn: { type: 'integer', default: 3600, description: '만료 시간(초)' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '서명 URL',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { signedUrl: { type: 'string', format: 'uri' } },
                },
              },
            },
          },
          400: { description: '파라미터 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/storage/audio/chunk': {
      post: {
        tags: ['storage'],
        summary: 'WAV 청크 단위 업로드',
        description: `WAV 파일을 청크 단위로 S3 스토리지에 업로드하고 \`session_chunks\` 테이블에 기록합니다.
저장 경로: \`{userId}/{sessionId}/{sessionId}-001.wav\`

**요청 형식**: \`multipart/form-data\`
- \`wavFile\`: WAV 바이너리 (Blob)
- \`meta\`: AES-256-GCM 암호화된 JSON`,
        security: [{ BearerAuth: [] }, { CookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['wavFile', 'meta'],
                properties: {
                  wavFile: { type: 'string', format: 'binary', description: 'WAV 오디오 파일' },
                  meta: {
                    type: 'string',
                    description: 'AES-256-GCM 암호화된 JSON 문자열. 복호화 후 형식: `{ sessionId, chunkIndex, startSec, endSec, durationSec, fileSizeBytes, text? }`',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '업로드 성공',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', description: 'Storage 저장 경로' },
                    chunkId: { type: 'string', format: 'uuid', description: 'session_chunks 레코드 ID' },
                  },
                },
              },
            },
          },
          400: { description: 'wavFile 또는 meta 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          500: { description: '서버 오류', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/api/storage/audio/chunks/{sessionId}': {
      get: {
        tags: ['storage'],
        summary: '세션 청크 목록 조회',
        description: '세션에 업로드된 WAV 청크 목록을 `chunk_index` 오름차순으로 반환합니다.',
        security: [{ BearerAuth: [] }, { CookieAuth: [] }],
        parameters: [
          { name: 'sessionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: '세션 ID' },
        ],
        responses: {
          200: {
            description: '청크 목록',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    chunks: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string', format: 'uuid' },
                          chunk_index: { type: 'integer' },
                          storage_path: { type: 'string' },
                          start_sec: { type: 'number' },
                          end_sec: { type: 'number' },
                          duration_sec: { type: 'number' },
                          upload_status: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          500: { description: '서버 오류', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/api/storage/user': {
      delete: {
        tags: ['storage'],
        summary: '사용자 파일 전체 삭제',
        description: '`sanitized-audio` 및 `meta-jsonl` 버킷에서 사용자의 모든 파일을 삭제합니다.',
        responses: {
          200: {
            description: '삭제 완료',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    deletedFiles: { type: 'integer' },
                  },
                },
              },
            },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Admin - Me ───────────────────────────────────────────────────
    '/api/admin/me': {
      get: {
        tags: ['admin'],
        summary: '어드민 본인 확인',
        description: 'JWT 검증 후 Supabase app_metadata.role === "admin" 서버 확인. 200 응답의 id/email은 AES-256-GCM 암호화된 값.',
        security: [{ BearerAuth: [] }, { CookieAuth: [] }],
        responses: {
          200: {
            description: '어드민 확인 성공',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    user: {
                      type: 'object',
                      properties: {
                        id: { $ref: '#/components/schemas/EncryptedString' },
                        email: { $ref: '#/components/schemas/EncryptedString' },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: '미인증', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: '어드민 권한 없음', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Admin - Clients ────────────────────────────────────────────────
    '/api/admin/clients': {
      get: {
        tags: ['admin'],
        summary: '클라이언트 목록 조회',
        responses: {
          200: { description: '클라이언트 목록', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object' } } } } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        tags: ['admin'],
        summary: '클라이언트 upsert',
        description: '> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                description: '클라이언트 데이터 (id 포함 시 업데이트, 없으면 생성)',
              },
            },
          },
        },
        responses: {
          200: { description: '저장 성공', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/admin/clients/{id}': {
      delete: {
        tags: ['admin'],
        summary: '클라이언트 삭제',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '삭제 성공', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Admin - Delivery Profiles ───────────────────────────────────────
    '/api/admin/delivery-profiles': {
      get: {
        tags: ['admin'],
        summary: '배송 프로필 목록 조회',
        parameters: [{ name: 'clientId', in: 'query', schema: { type: 'string' } }],
        responses: {
          200: { description: '목록', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object' } } } } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        tags: ['admin'],
        summary: '배송 프로필 upsert',
        description: '> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: {
          200: { description: '저장 성공', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/admin/delivery-profiles/{id}': {
      delete: {
        tags: ['admin'],
        summary: '배송 프로필 삭제',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '삭제 성공', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Admin - SKU Rules ───────────────────────────────────────────────
    '/api/admin/client-sku-rules': {
      get: {
        tags: ['admin'],
        summary: 'SKU 규칙 조회',
        parameters: [{ name: 'clientId', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'SKU 규칙 목록', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object' } } } } } } },
          400: { description: 'clientId 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        tags: ['admin'],
        summary: 'SKU 규칙 upsert',
        description: '> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: {
          200: { description: '저장 성공', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/admin/client-sku-rules/{id}': {
      delete: {
        tags: ['admin'],
        summary: 'SKU 규칙 삭제',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '삭제 성공', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Admin - SKU Presets ─────────────────────────────────────────────
    '/api/admin/sku-presets': {
      get: {
        tags: ['admin'],
        summary: 'SKU 프리셋 목록 조회',
        responses: {
          200: { description: '목록', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object' } } } } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        tags: ['admin'],
        summary: 'SKU 프리셋 upsert',
        description: '> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: {
          200: { description: '저장 성공', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/admin/sku-presets/{id}': {
      delete: {
        tags: ['admin'],
        summary: 'SKU 프리셋 삭제',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '삭제 성공', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Admin - Export Jobs ─────────────────────────────────────────────
    '/api/admin/export-jobs': {
      get: {
        tags: ['admin'],
        summary: '익스포트 작업 목록 (최근 200건)',
        responses: {
          200: { description: '목록', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object' } } } } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        tags: ['admin'],
        summary: '익스포트 작업 upsert',
        description: '> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: {
          200: { description: '저장 성공', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/admin/export-jobs/{id}': {
      get: {
        tags: ['admin'],
        summary: '익스포트 작업 상세 조회',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '작업 상세', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', nullable: true } } } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['admin'],
        summary: '익스포트 작업 삭제',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '삭제 성공', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/admin/export-jobs/{id}/logs': {
      post: {
        tags: ['admin'],
        summary: '익스포트 작업 로그 추가',
        description: '작업의 logs 배열에 로그 항목을 추가합니다.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['log'],
                properties: {
                  log: { type: 'object', description: '로그 항목 (자유 형식)' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: '추가 성공', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          404: { description: '작업 없음', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Admin - Billable Units ──────────────────────────────────────────
    '/api/admin/billable-units': {
      get: {
        tags: ['admin'],
        summary: '청구 단위 조회 (전체 페이지네이션)',
        parameters: [
          { name: 'qualityGrade', in: 'query', schema: { type: 'string' }, description: '콤마 구분 복수값 가능' },
          { name: 'qualityTier', in: 'query', schema: { type: 'string' }, description: '콤마 구분 복수값 가능' },
          { name: 'consentStatus', in: 'query', schema: { type: 'string' } },
          { name: 'lockStatus', in: 'query', schema: { type: 'string', enum: ['available', 'locked_for_job', 'delivered'] } },
          { name: 'userId', in: 'query', schema: { type: 'string' } },
          { name: 'dateFrom', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'dateTo', in: 'query', schema: { type: 'string', format: 'date' } },
        ],
        responses: {
          200: { description: '청구 단위 목록', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object' } } } } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        tags: ['admin'],
        summary: '청구 단위 일괄 upsert',
        description: '배치당 500건씩 처리합니다.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['units'],
                properties: {
                  units: { type: 'array', items: { type: 'object' } },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Upsert 완료',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        count: { type: 'integer' },
                        success: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
          400: { description: '유효성 오류', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/admin/billable-units/lock': {
      post: {
        tags: ['admin'],
        summary: '청구 단위 잠금 (작업 할당)',
        description: '지정된 단위들을 특정 작업에 잠급니다. `available` 상태인 단위만 잠깁니다.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['unitIds', 'jobId'],
                properties: {
                  unitIds: { type: 'array', items: { type: 'string' } },
                  jobId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '잠금 완료',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: { locked: { type: 'integer' } },
                    },
                  },
                },
              },
            },
          },
          400: { description: '파라미터 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/admin/billable-units/unlock': {
      post: {
        tags: ['admin'],
        summary: '청구 단위 잠금 해제',
        description: '특정 작업에 잠긴 단위들을 다시 `available` 상태로 변경합니다.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['jobId'],
                properties: {
                  jobId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: '해제 성공', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          400: { description: 'jobId 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/admin/billable-units/mark-delivered': {
      post: {
        tags: ['admin'],
        summary: '청구 단위 납품 완료 처리',
        description: '특정 작업에 잠긴 단위들을 `delivered` 상태로 변경합니다.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['jobId'],
                properties: {
                  jobId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: '처리 성공', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          400: { description: 'jobId 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Admin - Sessions & Transcripts ─────────────────────────────────
    '/api/admin/sessions': {
      get: {
        tags: ['admin'],
        summary: '전체 세션 조회 (어드민)',
        description: '사용자 필터 없이 전체 세션을 조회합니다. 다양한 필터를 조합할 수 있습니다.',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 200 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'domains', in: 'query', schema: { type: 'array', items: { type: 'string' } }, description: '도메인 필터 (복수 선택)' },
          { name: 'qualityGrades', in: 'query', schema: { type: 'array', items: { type: 'string', enum: ['A', 'B', 'C'] } } },
          { name: 'labelStatus', in: 'query', schema: { type: 'string', enum: ['labeled', 'unlabeled'] } },
          { name: 'publicStatus', in: 'query', schema: { type: 'string', enum: ['public', 'private'] } },
          { name: 'piiCleanedOnly', in: 'query', schema: { type: 'string', enum: ['true'] } },
          { name: 'hasAudioUrl', in: 'query', schema: { type: 'string', enum: ['true'] } },
          { name: 'diarizationStatus', in: 'query', schema: { type: 'string', enum: ['done', 'none'] } },
          { name: 'transcriptStatus', in: 'query', schema: { type: 'string', enum: ['done', 'none'] } },
          { name: 'uploadStatuses', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
          { name: 'dateFrom', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'dateTo', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'sortBy', in: 'query', schema: { type: 'string', enum: ['date', 'qaScore', 'duration'], default: 'date' } },
          { name: 'sortDir', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
        ],
        responses: {
          200: {
            description: '전체 세션',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { type: 'object' } },
                    count: { type: 'integer' },
                  },
                },
              },
            },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/admin/transcripts': {
      get: {
        tags: ['admin'],
        summary: '전체 전사 데이터 조회 (어드민)',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 500, maximum: 1000 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: {
          200: {
            description: '전체 전사 데이터',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          sessionId: { type: 'string' },
                          userId: { type: 'string' },
                          text: { type: 'string' },
                          summary: { type: 'string' },
                          words: { type: 'array', items: { type: 'object' } },
                          createdAt: { type: 'string', format: 'date-time' },
                        },
                      },
                    },
                    count: { type: 'integer' },
                  },
                },
              },
            },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    // ── Admin - Ledger Entries ──────────────────────────────────────────
    '/api/admin/ledger-entries': {
      get: {
        tags: ['admin'],
        summary: '원장 항목 조회',
        description: '`user_asset_ledger` 테이블을 전체 페이지네이션으로 조회합니다.',
        parameters: [
          { name: 'userId', in: 'query', schema: { type: 'string' }, description: '사용자 ID 필터' },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['estimated', 'confirmed', 'withdrawable', 'paid'] } },
          { name: 'exportJobId', in: 'query', schema: { type: 'string' } },
          { name: 'buIds', in: 'query', schema: { type: 'string' }, description: '콤마 구분 BU ID 목록' },
        ],
        responses: {
          200: { description: '원장 항목 목록', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object' } } } } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        tags: ['admin'],
        summary: '원장 항목 일괄 upsert',
        description: '배치당 500건씩 처리합니다.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['entries'],
                properties: {
                  entries: { type: 'array', items: { type: 'object' } },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Upsert 완료',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        count: { type: 'integer' },
                        success: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
          400: { description: '유효성 오류', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/admin/ledger-entries/update-status': {
      post: {
        tags: ['admin'],
        summary: '원장 항목 상태 일괄 변경',
        description: '여러 항목의 status를 한 번에 변경합니다. `confirmed` 시 `confirmed_at`, `withdrawable` 시 `withdrawable_at`, `paid` 시 `paid_at`이 자동 설정됩니다.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ids', 'status'],
                properties: {
                  ids: { type: 'array', items: { type: 'string' }, description: '변경할 항목 ID 목록' },
                  status: { type: 'string', enum: ['estimated', 'confirmed', 'withdrawable', 'paid'] },
                  confirmedAmount: { type: 'number', description: '확정 금액 (status=confirmed일 때 선택)' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '변경 완료',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: { updated: { type: 'integer' } },
                    },
                  },
                },
              },
            },
          },
          400: { description: '파라미터 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/admin/ledger-entries/confirm-job': {
      post: {
        tags: ['admin'],
        summary: '익스포트 작업 정산 확정',
        description: '특정 export_job에 속한 `estimated` 상태의 원장 항목들을 `confirmed`로 변경하고, `totalPayment`를 `amount_high` 비율로 배분합니다.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['exportJobId', 'totalPayment'],
                properties: {
                  exportJobId: { type: 'string' },
                  totalPayment: { type: 'number', description: '총 정산 금액' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '확정 완료',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: { confirmed: { type: 'integer', description: '확정된 항목 수' } },
                    },
                  },
                },
              },
            },
          },
          400: { description: '파라미터 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Admin - Delivery Records ─────────────────────────────────────────
    '/api/admin/delivery-records': {
      get: {
        tags: ['admin'],
        summary: '납품 기록 조회',
        parameters: [
          { name: 'clientId', in: 'query', required: true, schema: { type: 'string' }, description: '클라이언트 ID (필수)' },
        ],
        responses: {
          200: { description: '납품 기록 목록', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object' } } } } } } },
          400: { description: 'clientId 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        tags: ['admin'],
        summary: '납품 기록 생성',
        description: 'BU ID 목록을 특정 클라이언트/익스포트 작업에 납품 기록으로 등록합니다. 배치당 500건 처리. `bu_id + client_id` 중복 시 무시(idempotent).\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['buIds', 'clientId', 'exportJobId'],
                properties: {
                  buIds: { type: 'array', items: { type: 'string' }, description: '납품할 BU ID 목록' },
                  clientId: { type: 'string' },
                  exportJobId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '납품 기록 생성 완료',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        count: { type: 'integer' },
                        success: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
          400: { description: '파라미터 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/api/admin/reset-all': {
      delete: {
        tags: ['admin'],
        summary: '전체 데이터 초기화',
        description:
          '⚠️ **위험** - sessions, export_jobs, billable_units, error_logs, funnel_events 테이블의 모든 데이터를 삭제합니다. 테스트 환경 전용.',
        responses: {
          200: {
            description: '초기화 결과',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        tables: {
                          type: 'object',
                          additionalProperties: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
                          description: '테이블별 삭제 건수 또는 에러 메시지',
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Logging ─────────────────────────────────────────────────────────
    '/api/logging/funnel': {
      post: {
        tags: ['logging'],
        summary: '퍼널 이벤트 배치 전송',
        description:
          '분석용 퍼널 이벤트를 배치로 저장합니다. 익명 요청도 허용됩니다. `id` 충돌 시 무시(idempotent).\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['events'],
                properties: {
                  events: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['id', 'step', 'timestamp'],
                      properties: {
                        id: { type: 'string', description: '이벤트 고유 ID (중복 전송 방지)' },
                        step: { type: 'string', description: '퍼널 단계명' },
                        timestamp: { type: 'string', format: 'date-time' },
                        date_bucket: { type: 'string', description: 'YYYY-MM-DD 형식의 날짜 버킷' },
                        user_id: { type: 'string', nullable: true },
                        meta: { type: 'object', nullable: true, description: '추가 메타데이터' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '저장 완료',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        count: { type: 'integer' },
                        success: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
          400: { description: '이벤트 배열 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/logging/errors': {
      post: {
        tags: ['logging'],
        summary: '에러 로그 배치 전송',
        description:
          '클라이언트 에러를 배치로 저장합니다. 익명 요청도 허용됩니다. `id` 충돌 시 무시(idempotent).\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['logs'],
                properties: {
                  logs: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['id', 'timestamp', 'level', 'message'],
                      properties: {
                        id: { type: 'string', description: '로그 고유 ID' },
                        timestamp: { type: 'string', format: 'date-time' },
                        level: { type: 'string', enum: ['debug', 'info', 'warn', 'error', 'fatal'] },
                        message: { type: 'string' },
                        stack: { type: 'string', nullable: true },
                        context: { type: 'object', nullable: true },
                        userId: { type: 'string', nullable: true },
                        deviceInfo: { type: 'object', nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '저장 완료',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        count: { type: 'integer' },
                        success: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
          400: { description: '로그 배열 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Transcripts ─────────────────────────────────────────────────────
    '/api/transcripts': {
      get: {
        tags: ['transcripts'],
        summary: '전사 데이터 목록 조회',
        description: '현재 사용자의 모든 전사 데이터를 최신순으로 반환합니다.',
        responses: {
          200: {
            description: '전사 목록 (민감 필드 암호화)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Transcript' },
                    },
                  },
                },
              },
            },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/transcripts/{sessionId}': {
      post: {
        tags: ['transcripts'],
        summary: '전사 데이터 저장/업데이트',
        description:
          '세션 ID 기준으로 upsert합니다. 같은 세션 ID가 있으면 덮어씁니다.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['text'],
                properties: {
                  text: { type: 'string', description: '전사 텍스트 (전체 내용)' },
                  summary: { type: 'string', description: '요약 (선택)' },
                  words: {
                    type: 'array',
                    description: '단어별 타이밍 정보 (선택)',
                    items: {
                      type: 'object',
                      properties: {
                        word: { type: 'string' },
                        start: { type: 'number', description: '시작 시간(초)' },
                        end: { type: 'number', description: '종료 시간(초)' },
                        probability: { type: 'number', minimum: 0, maximum: 1 },
                      },
                    },
                  },
                  source: { type: 'string', description: 'STT 소스 (예: whisper, google)' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '저장된 전사 데이터 (민감 필드 암호화)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { $ref: '#/components/schemas/Transcript' } },
                },
              },
            },
          },
          400: { description: 'text 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      get: {
        tags: ['transcripts'],
        summary: '전사 데이터 조회',
        parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: {
            description: '전사 데이터 (없으면 data: null)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { $ref: '#/components/schemas/Transcript', nullable: true } },
                },
              },
            },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['transcripts'],
        summary: '전사 데이터 삭제',
        parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: '삭제 성공', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Transcript Chunks ──────────────────────────────────────────────
    '/api/transcript-chunks': {
      post: {
        tags: ['transcript-chunks'],
        summary: '청크별 전사 + 오디오 통계 저장',
        description: `세션 청크 단위의 전사 텍스트와 오디오 품질 지표를 저장합니다.
\`session_id + chunk_index\` 충돌 시 upsert 처리됩니다.

> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요`,
        security: [{ BearerAuth: [] }, { CookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['sessionId', 'chunkIndex', 'startSec', 'endSec', 'durationSec'],
                properties: {
                  sessionId: { type: 'string', format: 'uuid', description: '세션 ID' },
                  chunkIndex: { type: 'integer', description: '청크 순서 (1부터 시작)' },
                  transcriptText: { type: 'string', nullable: true, description: '전사 텍스트' },
                  startSec: { type: 'number', description: '청크 시작 시간 (초)' },
                  endSec: { type: 'number', description: '청크 종료 시간 (초)' },
                  durationSec: { type: 'number', description: '청크 길이 (초)' },
                  audioStats: {
                    type: 'object',
                    nullable: true,
                    description: '오디오 품질 지표',
                    properties: {
                      rms: { type: 'number', description: 'RMS 음량 (0~1)' },
                      snrDb: { type: 'number', description: '신호 대 잡음비 (dB)' },
                      silenceRatio: { type: 'number', description: '무음 구간 비율 (0~1)' },
                      clippingRatio: { type: 'number', description: '클리핑 비율 (0~1)' },
                    },
                  },
                  words: {
                    type: 'array',
                    nullable: true,
                    description: '단어 타임스탬프 배열',
                    items: {
                      type: 'object',
                      properties: {
                        word: { type: 'string' },
                        start: { type: 'number' },
                        end: { type: 'number' },
                        probability: { type: 'number' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '저장 성공',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { ok: { type: 'boolean', example: true } },
                },
              },
            },
          },
          400: { description: '필수 필드 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          500: { description: '서버 오류', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Session Chunks ───────────────────────────────────────────────
    '/api/session-chunks/{sessionId}/{chunkIndex}/labels': {
      put: {
        tags: ['session-chunks'],
        summary: '청크 라벨 업데이트',
        description: '특정 청크의 labels를 업데이트합니다. sessions.labels가 NULL인 경우 자동으로 동기화됩니다 (사용자 확정 라벨 보호).\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        security: [{ BearerAuth: [] }, { CookieAuth: [] }],
        parameters: [
          { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' }, description: '세션 ID' },
          { name: 'chunkIndex', in: 'path', required: true, schema: { type: 'integer' }, description: '청크 인덱스' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['labels'],
                properties: {
                  labels: { type: 'object', description: '레이블 데이터 (tone, noise, purpose 등)' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '업데이트 성공',
            content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } },
          },
          400: { description: '파라미터 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: '청크 없음', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── User ─────────────────────────────────────────────────────────
    '/api/user/consent': {
      get: {
        tags: ['user'],
        summary: '사용자 동의 상태 조회',
        description: '현재 사용자의 데이터 수집/제3자 제공/철회 동의 상태를 조회합니다.',
        security: [{ BearerAuth: [] }, { CookieAuth: [] }],
        responses: {
          200: {
            description: '동의 상태',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    collect_consent: { type: 'boolean' },
                    collect_consent_updated_at: { type: 'string', format: 'date-time', nullable: true },
                    third_party_consent: { type: 'boolean' },
                    third_party_consent_updated_at: { type: 'string', format: 'date-time', nullable: true },
                    consent_withdrawn: { type: 'boolean' },
                    consent_withdrawn_updated_at: { type: 'string', format: 'date-time', nullable: true },
                    sku_consents: { type: 'object', additionalProperties: { type: 'boolean' } },
                  },
                },
              },
            },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      put: {
        tags: ['user'],
        summary: '사용자 동의 상태 수정',
        description: '부분 업데이트 가능. 기존 값과 병합됩니다. 프로필 행이 없으면 자동 생성.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        security: [{ BearerAuth: [] }, { CookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  collect_consent: { type: 'boolean' },
                  third_party_consent: { type: 'boolean' },
                  consent_withdrawn: { type: 'boolean' },
                  sku_consents: { type: 'object', additionalProperties: { type: 'boolean' } },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '수정된 동의 상태',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'object', description: '병합된 동의 필드 + updated_at' },
                  },
                },
              },
            },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          500: { description: '서버 오류', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Admin - Additional endpoints ─────────────────────────────────
    '/api/admin/users/stats': {
      get: {
        tags: ['admin'],
        summary: '사용자별 통계 (어드민)',
        description: '사용자별 세션 수, 총 시간, 평균 QA, 라벨 비율, 품질 분포를 조회합니다.',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 200 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'sortBy', in: 'query', schema: { type: 'string', enum: ['sessionCount', 'totalDuration', 'avgQaScore'] } },
          { name: 'sortDir', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
        ],
        responses: {
          200: {
            description: '사용자 통계 목록',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          userId: { $ref: '#/components/schemas/EncryptedString' },
                          displayId: { type: 'string' },
                          sessionCount: { type: 'integer' },
                          totalDurationHours: { type: 'number' },
                          avgQaScore: { type: 'number' },
                          labeledRatio: { type: 'number' },
                          qualityDistribution: {
                            type: 'object',
                            properties: { A: { type: 'integer' }, B: { type: 'integer' }, C: { type: 'integer' } },
                          },
                          publicCount: { type: 'integer' },
                        },
                      },
                    },
                    count: { type: 'integer' },
                  },
                },
              },
            },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/admin/transcript-ids': {
      get: {
        tags: ['admin'],
        summary: '전사 보유 세션 ID 목록',
        description: '전사 데이터가 있는 세션 ID 목록을 반환합니다.',
        responses: {
          200: {
            description: '세션 ID 목록',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'string' } } } } } },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/admin/transcripts/bulk': {
      post: {
        tags: ['admin'],
        summary: '전사 데이터 일괄 조회',
        description: '세션 ID 목록으로 전사 데이터를 일괄 조회합니다. 배치당 500건.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['sessionIds'],
                properties: {
                  sessionIds: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '전사 데이터 목록',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          sessionId: { type: 'string' },
                          text: { type: 'string' },
                          words: { type: 'array', items: { type: 'object' } },
                          summary: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          400: { description: 'sessionIds 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/admin/storage/wavs': {
      get: {
        tags: ['admin'],
        summary: '전체 WAV 파일 목록 (어드민)',
        description: 'sanitized-audio 버킷의 모든 WAV 파일을 반환합니다.',
        responses: {
          200: {
            description: 'WAV 파일 목록',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          userId: { type: 'string' },
                          sessionId: { type: 'string' },
                          path: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/admin/storage/metas': {
      get: {
        tags: ['admin'],
        summary: '전체 Meta JSONL 파일 목록 (어드민)',
        description: 'meta-jsonl 버킷의 모든 JSONL 파일을 반환합니다.',
        responses: {
          200: {
            description: 'Meta JSONL 파일 목록',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          userId: { type: 'string' },
                          batchId: { type: 'string' },
                          path: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/admin/storage/signed-url': {
      post: {
        tags: ['admin'],
        summary: '서명 URL 발급 (어드민)',
        description: '어드민용 스토리지 서명 URL.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['storagePath'],
                properties: {
                  storagePath: { type: 'string' },
                  expiresIn: { type: 'integer', default: 300 },
                  bucket: { type: 'string', enum: ['audio', 'meta'], default: 'audio', description: '대상 버킷 (기본: audio)' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '서명 URL',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: { signedUrl: { type: 'string' } } } } } } },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/admin/session-chunks/batch-signed-urls': {
      post: {
        tags: ['admin'],
        summary: '세션 청크 일괄 서명 URL',
        description: '세션 ID 목록으로 청크별 서명 URL을 일괄 발급합니다.\n\n> ⚠️ 요청 바디는 AES-256-GCM 암호화 필요',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['sessionIds'],
                properties: {
                  sessionIds: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '청크별 서명 URL 목록',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          sessionId: { type: 'string' },
                          minuteIndex: { type: 'integer' },
                          storagePath: { type: 'string' },
                          signedUrl: { type: 'string' },
                          durationSeconds: { type: 'number' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/admin/sync-audio-urls': {
      post: {
        tags: ['admin'],
        summary: '오디오 URL 동기화',
        description: '스토리지를 스캔하여 sessions.audio_url이 NULL인 세션의 URL을 자동 설정합니다.',
        responses: {
          200: {
            description: '동기화 결과',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        updated: { type: 'integer' },
                        total: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: '인증 필요', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
  },
} as const

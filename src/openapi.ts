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
          chunkCount: { type: 'integer' },
          audioUrl: { $ref: '#/components/schemas/EncryptedString' },
          dupStatus: { type: 'string', enum: ['none', 'duplicate', 'original'] },
          dupGroupId: { $ref: '#/components/schemas/EncryptedString' },
          dupConfidence: { type: 'number', nullable: true },
          uploadStatus: { type: 'string', enum: ['LOCAL', 'UPLOADED', 'FAILED'] },
          piiStatus: { type: 'string', enum: ['CLEAR', 'PENDING', 'FLAGGED'] },
          shareScope: { type: 'string', enum: ['PRIVATE', 'PUBLIC', 'TEAM'] },
          eligibleForShare: { type: 'boolean' },
          consentStatus: { type: 'string', enum: ['locked', 'consented', 'denied'] },
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
        description: 'Google 로그인 페이지로 리다이렉트합니다.',
        security: [],
        parameters: [
          {
            name: 'redirect',
            in: 'query',
            description: 'OAuth 완료 후 리다이렉트 URL',
            schema: { type: 'string', example: 'http://localhost:5173/auth' },
          },
        ],
        responses: {
          302: { description: 'Google 로그인 페이지로 리다이렉트' },
          500: { description: 'OAuth URL 생성 실패', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
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
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
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
      delete: {
        tags: ['sessions'],
        summary: '세션 삭제',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: '삭제 성공', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } },
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
        description: '사용자 필터 없이 전체 세션을 조회합니다.',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 1000, maximum: 2000 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
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
  },
} as const

export const apiSpec = {
  openapi: "3.0.0",
  info: {
    title: "T Rock CRM API",
    version: "1.0.0",
    description:
      "Multi-tenant CRM API for T Rock Construction. All endpoints under /api/* require cookie-based JWT authentication except auth endpoints. Tenant context is derived from the authenticated user's office.",
  },
  servers: [
    { url: "http://localhost:3001", description: "Local development" },
    { url: "https://api.trock-crm.railway.app", description: "Production (Railway)" },
  ],
  tags: [
    { name: "Auth", description: "Authentication — dev login, SSO, MS Graph OAuth" },
    { name: "Deals", description: "Deal CRUD, stage changes, approvals, pipeline" },
    { name: "Contacts", description: "Contact CRUD, dedup, merge, deal associations" },
    { name: "Companies", description: "Company directory, contacts & deals by company" },
    { name: "Tasks", description: "Task management — create, complete, snooze, dismiss" },
    { name: "Activities", description: "Activity logging — calls, notes, meetings, emails" },
    { name: "Files", description: "File uploads via presigned R2 URLs, versioning, folder tree" },
    { name: "Email", description: "Send and retrieve emails via MS Graph" },
    { name: "Reports", description: "Locked analytics reports and custom saved reports" },
    { name: "Dashboard", description: "Rep and director dashboard aggregations" },
    { name: "Pipeline", description: "Pipeline configuration — stages, lost reasons, project types, regions" },
    { name: "Search", description: "Global cross-entity search" },
    { name: "Notifications", description: "SSE stream and notification CRUD" },
    { name: "Admin", description: "Platform administration — offices, users, audit log" },
    { name: "Migration", description: "Data migration — staged deals and contacts approval workflow" },
    { name: "Procore", description: "Procore sync status and conflict resolution" },
  ],
  components: {
    securitySchemes: {
      cookieAuth: {
        type: "apiKey",
        in: "cookie",
        name: "token",
        description: "HttpOnly JWT cookie issued at login. Sent automatically by browser.",
      },
    },
    schemas: {
      // -----------------------------------------------------------------------
      // Core entities
      // -----------------------------------------------------------------------
      Deal: {
        type: "object",
        description: "A sales opportunity (deal) tracked through the pipeline.",
        properties: {
          id: { type: "string", format: "uuid" },
          dealNumber: { type: "string", example: "TRC-2026-001", description: "Auto-assigned unique deal number." },
          name: { type: "string", example: "Greystar Midtown Office Build-Out" },
          stageId: { type: "string", format: "uuid", description: "FK to pipeline_stage_config." },
          assignedRepId: { type: "string", format: "uuid" },
          primaryContactId: { type: "string", format: "uuid", nullable: true },
          companyId: { type: "string", format: "uuid", nullable: true },
          ddEstimate: { type: "string", nullable: true, description: "Due-diligence estimate (numeric string from Postgres).", example: "250000.00" },
          bidEstimate: { type: "string", nullable: true, example: "480000.00" },
          awardedAmount: { type: "string", nullable: true, example: "495000.00" },
          changeOrderTotal: { type: "string", default: "0", example: "12500.00" },
          description: { type: "string", nullable: true },
          propertyAddress: { type: "string", nullable: true },
          propertyCity: { type: "string", nullable: true },
          propertyState: { type: "string", maxLength: 2, nullable: true, example: "TX" },
          propertyZip: { type: "string", nullable: true, example: "75201" },
          projectTypeId: { type: "string", format: "uuid", nullable: true },
          regionId: { type: "string", format: "uuid", nullable: true },
          source: { type: "string", nullable: true, example: "HubSpot" },
          winProbability: { type: "integer", minimum: 0, maximum: 100, nullable: true },
          procoreProjectId: { type: "integer", nullable: true },
          procoreBidId: { type: "integer", nullable: true },
          procoreLastSyncedAt: { type: "string", format: "date-time", nullable: true },
          lostReasonId: { type: "string", format: "uuid", nullable: true },
          lostNotes: { type: "string", nullable: true },
          lostCompetitor: { type: "string", nullable: true },
          lostAt: { type: "string", format: "date-time", nullable: true },
          expectedCloseDate: { type: "string", format: "date", nullable: true },
          actualCloseDate: { type: "string", format: "date", nullable: true },
          lastActivityAt: { type: "string", format: "date-time", nullable: true },
          stageEnteredAt: { type: "string", format: "date-time" },
          isActive: { type: "boolean", default: true },
          hubspotDealId: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "dealNumber", "name", "stageId", "assignedRepId", "isActive", "createdAt", "updatedAt"],
      },

      DealApproval: {
        type: "object",
        description: "An approval request for a stage transition that requires elevated role sign-off.",
        properties: {
          id: { type: "string", format: "uuid" },
          dealId: { type: "string", format: "uuid" },
          targetStageId: { type: "string", format: "uuid" },
          requiredRole: { type: "string", enum: ["director", "admin"] },
          requestedBy: { type: "string", format: "uuid" },
          approvedBy: { type: "string", format: "uuid", nullable: true },
          status: { type: "string", enum: ["pending", "approved", "rejected"] },
          notes: { type: "string", nullable: true },
          resolvedAt: { type: "string", format: "date-time", nullable: true },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "dealId", "targetStageId", "requiredRole", "requestedBy", "status", "createdAt"],
      },

      StageHistory: {
        type: "object",
        description: "An entry recording when a deal moved from one stage to another.",
        properties: {
          id: { type: "string", format: "uuid" },
          dealId: { type: "string", format: "uuid" },
          fromStageId: { type: "string", format: "uuid", nullable: true },
          toStageId: { type: "string", format: "uuid" },
          changedBy: { type: "string", format: "uuid" },
          overrideReason: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "dealId", "toStageId", "changedBy", "createdAt"],
      },

      Contact: {
        type: "object",
        description: "A person in the CRM. May be associated with multiple deals and one company.",
        properties: {
          id: { type: "string", format: "uuid" },
          firstName: { type: "string", example: "Jane" },
          lastName: { type: "string", example: "Smith" },
          email: { type: "string", format: "email", nullable: true },
          phone: { type: "string", nullable: true, example: "214-555-1234" },
          mobile: { type: "string", nullable: true },
          companyName: { type: "string", nullable: true },
          companyId: { type: "string", format: "uuid", nullable: true },
          jobTitle: { type: "string", nullable: true, example: "VP of Real Estate" },
          category: {
            type: "string",
            enum: ["owner", "gc", "architect", "subcontractor", "supplier", "broker", "lender", "inspector", "other"],
            description: "Contact classification.",
          },
          address: { type: "string", nullable: true },
          city: { type: "string", nullable: true },
          state: { type: "string", maxLength: 2, nullable: true },
          zip: { type: "string", nullable: true },
          notes: { type: "string", nullable: true },
          touchpointCount: { type: "integer", default: 0 },
          lastContactedAt: { type: "string", format: "date-time", nullable: true },
          firstOutreachCompleted: { type: "boolean", default: false },
          procoreContactId: { type: "integer", nullable: true },
          hubspotContactId: { type: "string", nullable: true },
          normalizedPhone: { type: "string", nullable: true },
          isActive: { type: "boolean", default: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "firstName", "lastName", "category", "isActive", "createdAt", "updatedAt"],
      },

      ContactDealAssociation: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          contactId: { type: "string", format: "uuid" },
          dealId: { type: "string", format: "uuid" },
          role: { type: "string", nullable: true, example: "Decision Maker" },
          isPrimary: { type: "boolean", default: false },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "contactId", "dealId", "createdAt"],
      },

      Company: {
        type: "object",
        description: "An organization in the CRM.",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string", example: "Greystar Real Estate Partners" },
          slug: { type: "string", example: "greystar-real-estate-partners" },
          category: {
            type: "string",
            enum: ["owner", "gc", "architect", "subcontractor", "supplier", "broker", "lender", "inspector", "other"],
          },
          address: { type: "string", nullable: true },
          city: { type: "string", nullable: true },
          state: { type: "string", maxLength: 2, nullable: true },
          zip: { type: "string", nullable: true },
          phone: { type: "string", nullable: true },
          website: { type: "string", nullable: true },
          notes: { type: "string", nullable: true },
          isActive: { type: "boolean", default: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "name", "slug", "category", "isActive", "createdAt", "updatedAt"],
      },

      Task: {
        type: "object",
        description: "A to-do item assigned to a rep, optionally linked to a deal or contact.",
        properties: {
          id: { type: "string", format: "uuid" },
          title: { type: "string", example: "Follow up on bid submission" },
          description: { type: "string", nullable: true },
          type: {
            type: "string",
            enum: ["manual", "follow_up", "approval", "email_reply", "stage_action"],
            description: "Task origin type.",
          },
          priority: { type: "string", enum: ["low", "normal", "high", "urgent"], default: "normal" },
          status: { type: "string", enum: ["pending", "scheduled", "in_progress", "waiting_on", "blocked", "completed", "dismissed"], default: "pending" },
          assignedTo: { type: "string", format: "uuid" },
          assignedToName: { type: "string", nullable: true, description: "Display name of the assigned user, when available." },
          createdBy: { type: "string", format: "uuid", nullable: true },
          dealId: { type: "string", format: "uuid", nullable: true },
          contactId: { type: "string", format: "uuid", nullable: true },
          emailId: { type: "string", format: "uuid", nullable: true },
          dueDate: { type: "string", format: "date", nullable: true },
          dueTime: { type: "string", nullable: true, example: "09:00:00" },
          remindAt: { type: "string", format: "date-time", nullable: true },
          scheduledFor: { type: "string", format: "date-time", nullable: true },
          waitingOn: { type: "object", nullable: true, additionalProperties: true },
          blockedBy: { type: "object", nullable: true, additionalProperties: true },
          startedAt: { type: "string", format: "date-time", nullable: true },
          completedAt: { type: "string", format: "date-time", nullable: true },
          isOverdue: { type: "boolean", default: false },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "title", "type", "priority", "status", "assignedTo", "isOverdue", "createdAt", "updatedAt"],
      },

      TaskCounts: {
        type: "object",
        properties: {
          overdue: { type: "integer" },
          today: { type: "integer" },
          upcoming: { type: "integer" },
          completed: { type: "integer" },
        },
        required: ["overdue", "today", "upcoming", "completed"],
      },

      Activity: {
        type: "object",
        description: "A logged interaction — call, note, meeting, or email — for a deal or contact.",
        properties: {
          id: { type: "string", format: "uuid" },
          type: {
            type: "string",
            enum: ["call", "email", "note", "meeting", "site_visit", "text"],
            description: "Activity type.",
          },
          userId: { type: "string", format: "uuid", description: "Who logged the activity." },
          dealId: { type: "string", format: "uuid", nullable: true },
          contactId: { type: "string", format: "uuid", nullable: true },
          emailId: { type: "string", format: "uuid", nullable: true },
          subject: { type: "string", nullable: true, example: "Initial discovery call" },
          body: { type: "string", nullable: true, description: "Full notes or email body." },
          outcome: { type: "string", nullable: true, example: "Left voicemail" },
          durationMinutes: { type: "integer", nullable: true },
          occurredAt: { type: "string", format: "date-time" },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "type", "userId", "occurredAt", "createdAt"],
      },

      File: {
        type: "object",
        description: "A file stored in Cloudflare R2, linked to a deal or contact.",
        properties: {
          id: { type: "string", format: "uuid" },
          category: {
            type: "string",
            enum: ["photo", "document", "drawing", "bid", "contract", "change_order", "report", "other"],
          },
          subcategory: { type: "string", nullable: true },
          folderPath: { type: "string", nullable: true, example: "Bids/2026" },
          tags: { type: "array", items: { type: "string" }, default: [] },
          displayName: { type: "string", example: "Midtown Bid Package v3.pdf" },
          systemFilename: { type: "string" },
          originalFilename: { type: "string" },
          mimeType: { type: "string", example: "application/pdf" },
          fileSizeBytes: { type: "integer", example: 2048000 },
          fileExtension: { type: "string", example: "pdf" },
          r2Key: { type: "string" },
          r2Bucket: { type: "string" },
          dealId: { type: "string", format: "uuid", nullable: true },
          contactId: { type: "string", format: "uuid", nullable: true },
          procoreProjectId: { type: "integer", nullable: true },
          changeOrderId: { type: "string", format: "uuid", nullable: true },
          description: { type: "string", nullable: true },
          notes: { type: "string", nullable: true },
          version: { type: "integer", default: 1 },
          parentFileId: { type: "string", format: "uuid", nullable: true },
          takenAt: { type: "string", format: "date-time", nullable: true, description: "For photos — when the photo was taken." },
          geoLat: { type: "number", nullable: true, example: 32.7767 },
          geoLng: { type: "number", nullable: true, example: -96.797 },
          uploadedBy: { type: "string", format: "uuid" },
          isActive: { type: "boolean", default: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "category", "displayName", "systemFilename", "originalFilename", "mimeType", "fileSizeBytes", "fileExtension", "r2Key", "r2Bucket", "uploadedBy", "isActive", "createdAt", "updatedAt"],
      },

      Email: {
        type: "object",
        description: "An email sent from or received by a CRM user, synced via MS Graph.",
        properties: {
          id: { type: "string", format: "uuid" },
          userId: { type: "string", format: "uuid", description: "CRM user who sent/received this email." },
          dealId: { type: "string", format: "uuid", nullable: true },
          contactId: { type: "string", format: "uuid", nullable: true },
          direction: { type: "string", enum: ["inbound", "outbound"] },
          subject: { type: "string" },
          bodyHtml: { type: "string", nullable: true },
          to: { type: "array", items: { type: "string", format: "email" } },
          cc: { type: "array", items: { type: "string", format: "email" }, nullable: true },
          conversationId: { type: "string", nullable: true, description: "MS Graph conversation/thread ID." },
          sentAt: { type: "string", format: "date-time", nullable: true },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "userId", "direction", "subject", "to", "createdAt"],
      },

      Notification: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          userId: { type: "string", format: "uuid" },
          title: { type: "string" },
          body: { type: "string", nullable: true },
          type: { type: "string", example: "stage_change" },
          isRead: { type: "boolean", default: false },
          payload: { type: "object", nullable: true, additionalProperties: true },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "userId", "title", "isRead", "createdAt"],
      },

      PipelineStage: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string", example: "Bid Submitted" },
          color: { type: "string", example: "#3B82F6" },
          order: { type: "integer" },
          probability: { type: "integer", minimum: 0, maximum: 100, nullable: true },
          isActive: { type: "boolean" },
          requiresApproval: { type: "boolean" },
          approvalRole: { type: "string", enum: ["director", "admin"], nullable: true },
          procoreStageMapping: { type: "string", nullable: true },
        },
        required: ["id", "name", "order", "isActive"],
      },

      LostReason: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          label: { type: "string", example: "Lost to competitor" },
          isActive: { type: "boolean" },
          order: { type: "integer" },
        },
        required: ["id", "label", "isActive"],
      },

      ProjectType: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string", example: "Office TI" },
          parentId: { type: "string", format: "uuid", nullable: true },
          isActive: { type: "boolean" },
        },
        required: ["id", "name", "isActive"],
      },

      Region: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string", example: "DFW Metro" },
          isActive: { type: "boolean" },
        },
        required: ["id", "name", "isActive"],
      },

      Office: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          slug: { type: "string" },
          address: { type: "string", nullable: true },
          phone: { type: "string", nullable: true },
          isActive: { type: "boolean" },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "name", "slug", "isActive"],
      },

      User: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          email: { type: "string", format: "email" },
          displayName: { type: "string" },
          role: { type: "string", enum: ["admin", "director", "rep"] },
          officeId: { type: "string", format: "uuid" },
          activeOfficeId: { type: "string", format: "uuid", nullable: true },
          isActive: { type: "boolean" },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "email", "displayName", "role", "officeId", "isActive"],
      },

      AuditLogEntry: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          tableName: { type: "string" },
          recordId: { type: "string", format: "uuid" },
          action: { type: "string", enum: ["INSERT", "UPDATE", "DELETE"] },
          changedBy: { type: "string", format: "uuid", nullable: true },
          oldData: { type: "object", nullable: true, additionalProperties: true },
          newData: { type: "object", nullable: true, additionalProperties: true },
          changedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "tableName", "recordId", "action", "changedAt"],
      },

      ProcoreSyncState: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          crmEntityType: { type: "string", example: "deal" },
          crmEntityId: { type: "string", format: "uuid" },
          procoreId: { type: "string" },
          syncStatus: { type: "string", enum: ["synced", "pending", "conflict", "error"] },
          conflictData: { type: "object", nullable: true, additionalProperties: true },
          errorMessage: { type: "string", nullable: true },
          lastSyncedAt: { type: "string", format: "date-time", nullable: true },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "crmEntityType", "crmEntityId", "procoreId", "syncStatus"],
      },

      SavedReport: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          entity: { type: "string", enum: ["deals", "contacts", "activities", "tasks"] },
          config: { type: "object", additionalProperties: true, description: "ReportConfig JSON." },
          visibility: { type: "string", enum: ["private", "office", "locked"] },
          officeId: { type: "string", format: "uuid" },
          createdBy: { type: "string", format: "uuid" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "name", "entity", "config", "visibility", "officeId", "createdBy", "createdAt"],
      },

      ReportConfig: {
        type: "object",
        description: "Configuration for a custom report query.",
        properties: {
          entity: { type: "string", enum: ["deals", "contacts", "activities", "tasks"] },
          filters: { type: "array", items: { type: "object", additionalProperties: true } },
          groupBy: { type: "string", nullable: true },
          orderBy: { type: "string", nullable: true },
          orderDir: { type: "string", enum: ["asc", "desc"], nullable: true },
          columns: { type: "array", items: { type: "string" } },
        },
        required: ["entity"],
      },

      PaginatedResult: {
        type: "object",
        properties: {
          total: { type: "integer", description: "Total matching records." },
          page: { type: "integer" },
          limit: { type: "integer" },
          totalPages: { type: "integer" },
        },
        required: ["total", "page", "limit"],
      },

      ErrorResponse: {
        type: "object",
        properties: {
          error: { type: "string" },
          message: { type: "string" },
          statusCode: { type: "integer" },
        },
      },

      SuccessResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
        },
        required: ["success"],
      },
    },

    parameters: {
      PageParam: {
        name: "page",
        in: "query",
        schema: { type: "integer", default: 1, minimum: 1 },
        description: "Page number (1-indexed).",
      },
      LimitParam: {
        name: "limit",
        in: "query",
        schema: { type: "integer", default: 50, minimum: 1, maximum: 500 },
        description: "Records per page.",
      },
      SortDirParam: {
        name: "sortDir",
        in: "query",
        schema: { type: "string", enum: ["asc", "desc"] },
        description: "Sort direction.",
      },
      DateFromParam: {
        name: "from",
        in: "query",
        schema: { type: "string", format: "date" },
        description: "Start of date range (inclusive). ISO 8601 date.",
      },
      DateToParam: {
        name: "to",
        in: "query",
        schema: { type: "string", format: "date" },
        description: "End of date range (inclusive). ISO 8601 date.",
      },
    },
  },

  security: [{ cookieAuth: [] }],

  paths: {
    // =========================================================================
    // AUTH
    // =========================================================================
    "/api/auth/dev/users": {
      get: {
        tags: ["Auth"],
        summary: "List dev-mode users (dev only)",
        description: "Returns available test users when Azure SSO is not configured or DEV_MODE=true. Not available in production.",
        security: [],
        responses: {
          200: {
            description: "List of dev users.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    users: { type: "array", items: { $ref: "#/components/schemas/User" } },
                  },
                },
              },
            },
          },
          404: { description: "Dev mode not available (production environment)." },
        },
      },
    },

    "/api/auth/dev/login": {
      post: {
        tags: ["Auth"],
        summary: "Dev-mode login",
        description: "Issues a JWT cookie for a @trock.dev test account. Dev mode only.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  email: { type: "string", format: "email", example: "rep@trock.dev" },
                },
                required: ["email"],
              },
            },
          },
        },
        responses: {
          200: {
            description: "Login successful. Sets HttpOnly `token` cookie.",
            headers: {
              "Set-Cookie": {
                schema: { type: "string" },
                description: "HttpOnly JWT cookie (24h TTL).",
              },
            },
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    user: {
                      type: "object",
                      properties: {
                        id: { type: "string", format: "uuid" },
                        email: { type: "string" },
                        displayName: { type: "string" },
                        role: { type: "string", enum: ["admin", "director", "rep"] },
                        officeId: { type: "string", format: "uuid" },
                      },
                    },
                  },
                },
              },
            },
          },
          400: { description: "Email is required." },
          403: { description: "Not a @trock.dev email or user is inactive." },
          404: { description: "User not found or dev mode unavailable." },
        },
      },
    },

    "/api/auth/me": {
      get: {
        tags: ["Auth"],
        summary: "Get current authenticated user",
        responses: {
          200: {
            description: "Current user.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    user: { $ref: "#/components/schemas/User" },
                  },
                },
              },
            },
          },
          401: { description: "Not authenticated." },
        },
      },
    },

    "/api/auth/logout": {
      post: {
        tags: ["Auth"],
        summary: "Logout — clear auth cookie",
        responses: {
          200: {
            description: "Cookie cleared.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SuccessResponse" },
              },
            },
          },
        },
      },
    },

    "/api/auth/graph/consent": {
      get: {
        tags: ["Auth"],
        summary: "Get Microsoft Graph OAuth consent URL",
        description: "Returns the URL to redirect the user to Microsoft for email integration consent. In dev mode returns null URL.",
        responses: {
          200: {
            description: "Consent URL or dev-mode response.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    url: { type: "string", format: "uri", nullable: true },
                    devMode: { type: "boolean" },
                    message: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/api/auth/graph/callback": {
      get: {
        tags: ["Auth"],
        summary: "MS Graph OAuth callback (redirects)",
        description: "Handles the redirect from Microsoft after consent. Exchanges code for tokens and redirects the user back to the CRM email page.",
        security: [],
        parameters: [
          { name: "code", in: "query", schema: { type: "string" } },
          { name: "state", in: "query", schema: { type: "string" } },
          { name: "error", in: "query", schema: { type: "string" } },
        ],
        responses: {
          302: { description: "Redirect to /email?connected=true on success or /email?error=... on failure." },
        },
      },
    },

    "/api/auth/graph/status": {
      get: {
        tags: ["Auth"],
        summary: "Check MS Graph token status for current user",
        responses: {
          200: {
            description: "Token connection status.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    connected: { type: "boolean" },
                    email: { type: "string", nullable: true },
                    expiresAt: { type: "string", format: "date-time", nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/api/auth/graph/disconnect": {
      post: {
        tags: ["Auth"],
        summary: "Disconnect MS Graph / revoke email tokens",
        responses: {
          200: {
            description: "Tokens revoked.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SuccessResponse" },
              },
            },
          },
        },
      },
    },

    // =========================================================================
    // DEALS
    // =========================================================================
    "/api/deals": {
      get: {
        tags: ["Deals"],
        summary: "List deals",
        description: "Returns paginated, filtered, sorted deals. Reps see only their own deals; directors/admins see all.",
        parameters: [
          { name: "search", in: "query", schema: { type: "string" }, description: "Full-text search on deal name and number." },
          { name: "stageIds", in: "query", schema: { type: "string" }, description: "Comma-separated stage UUIDs to filter by." },
          { name: "assignedRepId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "projectTypeId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "regionId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "source", in: "query", schema: { type: "string" } },
          { name: "isActive", in: "query", schema: { type: "boolean", default: true }, description: "Set to false to include soft-deleted deals." },
          { name: "sortBy", in: "query", schema: { type: "string", enum: ["name", "createdAt", "updatedAt", "awardedAmount", "bidEstimate", "stageEnteredAt"] } },
          { $ref: "#/components/parameters/SortDirParam" },
          { $ref: "#/components/parameters/PageParam" },
          { $ref: "#/components/parameters/LimitParam" },
        ],
        responses: {
          200: {
            description: "Paginated deal list.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedResult" },
                    {
                      type: "object",
                      properties: {
                        deals: { type: "array", items: { $ref: "#/components/schemas/Deal" } },
                      },
                    },
                  ],
                },
              },
            },
          },
          401: { description: "Not authenticated." },
        },
      },
      post: {
        tags: ["Deals"],
        summary: "Create a deal",
        description: "Reps are always the assigned rep on deals they create. Directors/admins may assign to any user.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string", example: "Midtown Office Renovation" },
                  stageId: { type: "string", format: "uuid" },
                  assignedRepId: { type: "string", format: "uuid", description: "Ignored for reps; required for director/admin if different from self." },
                  primaryContactId: { type: "string", format: "uuid" },
                  companyId: { type: "string", format: "uuid" },
                  ddEstimate: { type: "string", example: "250000.00" },
                  bidEstimate: { type: "string", example: "480000.00" },
                  description: { type: "string" },
                  propertyAddress: { type: "string" },
                  propertyCity: { type: "string" },
                  propertyState: { type: "string", maxLength: 2 },
                  propertyZip: { type: "string" },
                  projectTypeId: { type: "string", format: "uuid" },
                  regionId: { type: "string", format: "uuid" },
                  source: { type: "string" },
                  winProbability: { type: "integer", minimum: 0, maximum: 100 },
                  expectedCloseDate: { type: "string", format: "date" },
                },
                required: ["name", "stageId"],
              },
            },
          },
        },
        responses: {
          201: {
            description: "Deal created.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { deal: { $ref: "#/components/schemas/Deal" } },
                },
              },
            },
          },
          400: { description: "name and stageId are required." },
        },
      },
    },

    "/api/deals/sources": {
      get: {
        tags: ["Deals"],
        summary: "Get distinct deal sources",
        description: "Returns all distinct source values for the filter dropdown.",
        responses: {
          200: {
            description: "Source list.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    sources: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/api/deals/pipeline": {
      get: {
        tags: ["Deals"],
        summary: "Get deals grouped by stage for Kanban view",
        parameters: [
          { name: "assignedRepId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "includeDd", in: "query", schema: { type: "boolean", default: false }, description: "Include due-diligence stage deals." },
        ],
        responses: {
          200: {
            description: "Deals grouped by stage.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  description: "Keys are stage IDs; values are arrays of deals.",
                  additionalProperties: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Deal" },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/api/deals/{id}": {
      get: {
        tags: ["Deals"],
        summary: "Get a deal by ID",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Deal.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { deal: { $ref: "#/components/schemas/Deal" } },
                },
              },
            },
          },
          404: { description: "Deal not found." },
        },
      },
      patch: {
        tags: ["Deals"],
        summary: "Update deal fields",
        description: "Partial update. Reps cannot change assignedRepId. Use POST /:id/stage to change stage.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  assignedRepId: { type: "string", format: "uuid", description: "Director/admin only." },
                  primaryContactId: { type: "string", format: "uuid" },
                  companyId: { type: "string", format: "uuid" },
                  ddEstimate: { type: "string" },
                  bidEstimate: { type: "string" },
                  awardedAmount: { type: "string" },
                  description: { type: "string" },
                  propertyAddress: { type: "string" },
                  propertyCity: { type: "string" },
                  propertyState: { type: "string" },
                  propertyZip: { type: "string" },
                  projectTypeId: { type: "string", format: "uuid" },
                  regionId: { type: "string", format: "uuid" },
                  source: { type: "string" },
                  winProbability: { type: "integer" },
                  expectedCloseDate: { type: "string", format: "date" },
                  lostReasonId: { type: "string", format: "uuid" },
                  lostNotes: { type: "string" },
                  lostCompetitor: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Updated deal.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { deal: { $ref: "#/components/schemas/Deal" } },
                },
              },
            },
          },
          403: { description: "Access denied." },
          404: { description: "Deal not found." },
        },
      },
      delete: {
        tags: ["Deals"],
        summary: "Soft-delete a deal (director/admin only)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: { description: "Deal deleted.", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessResponse" } } } },
          403: { description: "Insufficient role." },
          404: { description: "Deal not found." },
        },
      },
    },

    "/api/deals/{id}/detail": {
      get: {
        tags: ["Deals"],
        summary: "Get deal with full detail",
        description: "Returns deal plus stage history, approvals, change orders, and associated data.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Deal detail.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    deal: {
                      allOf: [
                        { $ref: "#/components/schemas/Deal" },
                        {
                          type: "object",
                          properties: {
                            stageHistory: { type: "array", items: { $ref: "#/components/schemas/StageHistory" } },
                            approvals: { type: "array", items: { $ref: "#/components/schemas/DealApproval" } },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          404: { description: "Deal not found." },
        },
      },
    },

    "/api/deals/{id}/stage": {
      post: {
        tags: ["Deals"],
        summary: "Change deal stage",
        description: "Validates stage gates, enforces approval requirements, logs history, and fires domain events.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  targetStageId: { type: "string", format: "uuid" },
                  overrideReason: { type: "string", description: "Required when overriding a stage gate." },
                  lostReasonId: { type: "string", format: "uuid", description: "Required when moving to a lost stage." },
                  lostNotes: { type: "string" },
                  lostCompetitor: { type: "string" },
                },
                required: ["targetStageId"],
              },
            },
          },
        },
        responses: {
          200: {
            description: "Stage changed.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    deal: { $ref: "#/components/schemas/Deal" },
                    stageHistory: { $ref: "#/components/schemas/StageHistory" },
                    eventsEmitted: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          400: { description: "targetStageId is required or stage gate validation failed." },
          403: { description: "Approval required." },
          404: { description: "Deal not found." },
        },
      },
    },

    "/api/deals/{id}/stage/preflight": {
      post: {
        tags: ["Deals"],
        summary: "Preflight stage change check",
        description: "Validates whether a stage change is allowed without committing it. Returns gate status and any missing requirements.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  targetStageId: { type: "string", format: "uuid" },
                },
                required: ["targetStageId"],
              },
            },
          },
        },
        responses: {
          200: {
            description: "Preflight result.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    allowed: { type: "boolean" },
                    requiresApproval: { type: "boolean" },
                    missingRequirements: { type: "array", items: { type: "string" } },
                    warnings: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/api/deals/{id}/approvals": {
      get: {
        tags: ["Deals"],
        summary: "List approvals for a deal",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Approval list.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    approvals: { type: "array", items: { $ref: "#/components/schemas/DealApproval" } },
                  },
                },
              },
            },
          },
          404: { description: "Deal not found." },
        },
      },
      post: {
        tags: ["Deals"],
        summary: "Request a stage approval",
        description: "Rep creates an approval request for a stage that requires a director/admin sign-off.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  targetStageId: { type: "string", format: "uuid" },
                  requiredRole: { type: "string", enum: ["director", "admin"] },
                },
                required: ["targetStageId", "requiredRole"],
              },
            },
          },
        },
        responses: {
          201: {
            description: "Approval created.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { approval: { $ref: "#/components/schemas/DealApproval" } },
                },
              },
            },
          },
          400: { description: "targetStageId and requiredRole are required." },
          404: { description: "Deal not found." },
        },
      },
    },

    "/api/deals/{id}/approvals/{approvalId}": {
      patch: {
        tags: ["Deals"],
        summary: "Resolve an approval (director/admin only)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "approvalId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["approved", "rejected"] },
                  notes: { type: "string" },
                },
                required: ["status"],
              },
            },
          },
        },
        responses: {
          200: {
            description: "Approval resolved.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { approval: { $ref: "#/components/schemas/DealApproval" } },
                },
              },
            },
          },
          400: { description: "Invalid status or approval already resolved." },
          403: { description: "Insufficient role." },
          404: { description: "Deal or approval not found." },
        },
      },
    },

    "/api/deals/{id}/contacts": {
      get: {
        tags: ["Deals"],
        summary: "Get contacts associated with a deal",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Contact associations.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    associations: { type: "array", items: { $ref: "#/components/schemas/ContactDealAssociation" } },
                  },
                },
              },
            },
          },
          404: { description: "Deal not found." },
        },
      },
    },

    // =========================================================================
    // CONTACTS
    // =========================================================================
    "/api/contacts": {
      get: {
        tags: ["Contacts"],
        summary: "List contacts",
        parameters: [
          { name: "search", in: "query", schema: { type: "string" } },
          { name: "category", in: "query", schema: { type: "string" } },
          { name: "companyName", in: "query", schema: { type: "string" } },
          { name: "city", in: "query", schema: { type: "string" } },
          { name: "state", in: "query", schema: { type: "string", maxLength: 2 } },
          { name: "isActive", in: "query", schema: { type: "boolean", default: true } },
          { name: "hasOutreach", in: "query", schema: { type: "boolean" }, description: "Filter by first outreach completed status." },
          { name: "sortBy", in: "query", schema: { type: "string" } },
          { $ref: "#/components/parameters/SortDirParam" },
          { $ref: "#/components/parameters/PageParam" },
          { $ref: "#/components/parameters/LimitParam" },
        ],
        responses: {
          200: {
            description: "Paginated contact list.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedResult" },
                    {
                      type: "object",
                      properties: {
                        contacts: { type: "array", items: { $ref: "#/components/schemas/Contact" } },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Contacts"],
        summary: "Create a contact",
        description: "Runs duplicate detection before creating. If fuzzy duplicates are found, returns a warning with suggestions so the user can decide.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  firstName: { type: "string" },
                  lastName: { type: "string" },
                  email: { type: "string", format: "email" },
                  phone: { type: "string" },
                  mobile: { type: "string" },
                  companyName: { type: "string" },
                  companyId: { type: "string", format: "uuid" },
                  jobTitle: { type: "string" },
                  category: {
                    type: "string",
                    enum: ["owner", "gc", "architect", "subcontractor", "supplier", "broker", "lender", "inspector", "other"],
                  },
                  address: { type: "string" },
                  city: { type: "string" },
                  state: { type: "string", maxLength: 2 },
                  zip: { type: "string" },
                  notes: { type: "string" },
                  skipDedupCheck: { type: "boolean", description: "Skip duplicate detection — use when user confirms after seeing warning." },
                },
                required: ["firstName", "lastName", "category"],
              },
            },
          },
        },
        responses: {
          201: {
            description: "Contact created.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { contact: { $ref: "#/components/schemas/Contact" } },
                },
              },
            },
          },
          200: {
            description: "Duplicate warning — contact NOT created. Re-submit with skipDedupCheck=true to force.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    contact: { type: "null" },
                    dedupWarning: { type: "boolean", example: true },
                    suggestions: { type: "array", items: { $ref: "#/components/schemas/Contact" } },
                  },
                },
              },
            },
          },
          400: { description: "firstName, lastName, and category are required." },
        },
      },
    },

    "/api/contacts/search": {
      get: {
        tags: ["Contacts"],
        summary: "Autocomplete contact search",
        parameters: [
          { name: "q", in: "query", required: true, schema: { type: "string", minLength: 1 }, description: "Search query." },
          { $ref: "#/components/parameters/LimitParam" },
        ],
        responses: {
          200: {
            description: "Search results.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    contacts: { type: "array", items: { $ref: "#/components/schemas/Contact" } },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/api/contacts/companies": {
      get: {
        tags: ["Contacts"],
        summary: "Get distinct company names from contacts",
        description: "Used to populate company filter dropdown.",
        responses: {
          200: {
            description: "List of company name strings.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    companies: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/api/contacts/needs-outreach": {
      get: {
        tags: ["Contacts"],
        summary: "Get contacts with no first outreach",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
        ],
        responses: {
          200: {
            description: "Contacts needing outreach.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    contacts: { type: "array", items: { $ref: "#/components/schemas/Contact" } },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/api/contacts/dedup-check": {
      post: {
        tags: ["Contacts"],
        summary: "Check for duplicate contacts without creating",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  firstName: { type: "string" },
                  lastName: { type: "string" },
                  email: { type: "string", format: "email" },
                  companyName: { type: "string" },
                },
                required: ["firstName", "lastName"],
              },
            },
          },
        },
        responses: {
          200: {
            description: "Dedup result.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    exactMatch: { $ref: "#/components/schemas/Contact", nullable: true },
                    fuzzySuggestions: { type: "array", items: { $ref: "#/components/schemas/Contact" } },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/api/contacts/duplicates": {
      get: {
        tags: ["Contacts"],
        summary: "Get duplicate queue (director/admin only)",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["pending", "merged", "dismissed"] } },
          { $ref: "#/components/parameters/PageParam" },
          { $ref: "#/components/parameters/LimitParam" },
        ],
        responses: {
          200: {
            description: "Paginated duplicate queue.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedResult" },
                    {
                      type: "object",
                      properties: {
                        entries: { type: "array", items: { type: "object", additionalProperties: true } },
                      },
                    },
                  ],
                },
              },
            },
          },
          403: { description: "Director or admin role required." },
        },
      },
    },

    "/api/contacts/duplicates/{id}/merge": {
      post: {
        tags: ["Contacts"],
        summary: "Merge two contacts (director/admin only)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" }, description: "Duplicate queue entry ID." }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  winnerId: { type: "string", format: "uuid", description: "Contact to keep." },
                  loserId: { type: "string", format: "uuid", description: "Contact to merge into winner and soft-delete." },
                },
                required: ["winnerId", "loserId"],
              },
            },
          },
        },
        responses: {
          200: {
            description: "Merge result.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    merge: { type: "object", additionalProperties: true },
                  },
                },
              },
            },
          },
          403: { description: "Director or admin role required." },
        },
      },
    },

    "/api/contacts/duplicates/{id}/dismiss": {
      post: {
        tags: ["Contacts"],
        summary: "Dismiss a duplicate entry (director/admin only)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Entry dismissed.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { entry: { type: "object", additionalProperties: true } },
                },
              },
            },
          },
          403: { description: "Director or admin role required." },
        },
      },
    },

    "/api/contacts/{id}": {
      get: {
        tags: ["Contacts"],
        summary: "Get a contact by ID",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Contact.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { contact: { $ref: "#/components/schemas/Contact" } },
                },
              },
            },
          },
          404: { description: "Contact not found." },
        },
      },
      patch: {
        tags: ["Contacts"],
        summary: "Update contact fields",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  firstName: { type: "string" },
                  lastName: { type: "string" },
                  email: { type: "string", format: "email" },
                  phone: { type: "string" },
                  mobile: { type: "string" },
                  companyName: { type: "string" },
                  companyId: { type: "string", format: "uuid" },
                  jobTitle: { type: "string" },
                  category: { type: "string" },
                  address: { type: "string" },
                  city: { type: "string" },
                  state: { type: "string" },
                  zip: { type: "string" },
                  notes: { type: "string" },
                  firstOutreachCompleted: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Updated contact.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { contact: { $ref: "#/components/schemas/Contact" } },
                },
              },
            },
          },
          404: { description: "Contact not found." },
        },
      },
      delete: {
        tags: ["Contacts"],
        summary: "Soft-delete a contact (director/admin only)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: { description: "Deleted.", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessResponse" } } } },
          403: { description: "Director or admin role required." },
        },
      },
    },

    "/api/contacts/{id}/deals": {
      get: {
        tags: ["Contacts"],
        summary: "Get deals associated with a contact",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Deal associations.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    associations: { type: "array", items: { $ref: "#/components/schemas/ContactDealAssociation" } },
                  },
                },
              },
            },
          },
          404: { description: "Contact not found." },
        },
      },
      post: {
        tags: ["Contacts"],
        summary: "Associate a contact with a deal",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  dealId: { type: "string", format: "uuid" },
                  role: { type: "string", example: "Decision Maker" },
                  isPrimary: { type: "boolean" },
                },
                required: ["dealId"],
              },
            },
          },
        },
        responses: {
          201: {
            description: "Association created.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { association: { $ref: "#/components/schemas/ContactDealAssociation" } },
                },
              },
            },
          },
          400: { description: "dealId is required." },
          404: { description: "Deal not found." },
        },
      },
    },

    "/api/contacts/associations/{associationId}": {
      patch: {
        tags: ["Contacts"],
        summary: "Update a contact-deal association",
        parameters: [{ name: "associationId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  role: { type: "string" },
                  isPrimary: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Updated association.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { association: { $ref: "#/components/schemas/ContactDealAssociation" } },
                },
              },
            },
          },
          403: { description: "Access denied." },
          404: { description: "Association not found." },
        },
      },
      delete: {
        tags: ["Contacts"],
        summary: "Remove a contact-deal association",
        parameters: [{ name: "associationId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: { description: "Removed.", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessResponse" } } } },
          403: { description: "Access denied." },
          404: { description: "Association not found." },
        },
      },
    },

    "/api/contacts/{id}/activities": {
      get: {
        tags: ["Contacts"],
        summary: "List activities for a contact",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { $ref: "#/components/parameters/PageParam" },
          { $ref: "#/components/parameters/LimitParam" },
        ],
        responses: {
          200: {
            description: "Activity list.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedResult" },
                    { type: "object", properties: { activities: { type: "array", items: { $ref: "#/components/schemas/Activity" } } } },
                  ],
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Contacts"],
        summary: "Log an activity for a contact",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["call", "email", "note", "meeting", "site_visit", "text"] },
                  subject: { type: "string" },
                  body: { type: "string" },
                  outcome: { type: "string" },
                  durationMinutes: { type: "integer" },
                  dealId: { type: "string", format: "uuid" },
                  occurredAt: { type: "string", format: "date-time" },
                },
                required: ["type"],
              },
            },
          },
        },
        responses: {
          201: {
            description: "Activity created.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { activity: { $ref: "#/components/schemas/Activity" } },
                },
              },
            },
          },
          400: { description: "Activity type is required." },
        },
      },
    },

    // =========================================================================
    // COMPANIES
    // =========================================================================
    "/api/companies": {
      get: {
        tags: ["Companies"],
        summary: "List companies",
        parameters: [
          { name: "search", in: "query", schema: { type: "string" } },
          { name: "category", in: "query", schema: { type: "string" } },
          { $ref: "#/components/parameters/PageParam" },
          { $ref: "#/components/parameters/LimitParam" },
        ],
        responses: {
          200: {
            description: "Paginated company list.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedResult" },
                    {
                      type: "object",
                      properties: {
                        companies: { type: "array", items: { $ref: "#/components/schemas/Company" } },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Companies"],
        summary: "Create a company",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  category: { type: "string", enum: ["owner", "gc", "architect", "subcontractor", "supplier", "broker", "lender", "inspector", "other"] },
                  address: { type: "string" },
                  city: { type: "string" },
                  state: { type: "string", maxLength: 2 },
                  zip: { type: "string" },
                  phone: { type: "string" },
                  website: { type: "string" },
                  notes: { type: "string" },
                },
                required: ["name"],
              },
            },
          },
        },
        responses: {
          201: {
            description: "Company created.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { company: { $ref: "#/components/schemas/Company" } } },
              },
            },
          },
          400: { description: "Company name is required." },
        },
      },
    },

    "/api/companies/search": {
      get: {
        tags: ["Companies"],
        summary: "Autocomplete company search",
        parameters: [
          { name: "q", in: "query", schema: { type: "string" }, description: "Search query." },
        ],
        responses: {
          200: {
            description: "Matching companies.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    companies: { type: "array", items: { $ref: "#/components/schemas/Company" } },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/api/companies/{id}": {
      get: {
        tags: ["Companies"],
        summary: "Get a company by ID (includes stats)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Company with aggregated stats.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    company: {
                      allOf: [
                        { $ref: "#/components/schemas/Company" },
                        {
                          type: "object",
                          properties: {
                            totalDeals: { type: "integer" },
                            activeDeals: { type: "integer" },
                            totalContacts: { type: "integer" },
                            totalAwardedAmount: { type: "string" },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          404: { description: "Company not found." },
        },
      },
      patch: {
        tags: ["Companies"],
        summary: "Update company fields",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  category: { type: "string" },
                  address: { type: "string" },
                  city: { type: "string" },
                  state: { type: "string" },
                  zip: { type: "string" },
                  phone: { type: "string" },
                  website: { type: "string" },
                  notes: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Updated company.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { company: { $ref: "#/components/schemas/Company" } } },
              },
            },
          },
          404: { description: "Company not found." },
        },
      },
    },

    "/api/companies/{id}/contacts": {
      get: {
        tags: ["Companies"],
        summary: "Get contacts for a company",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Contacts list.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { contacts: { type: "array", items: { $ref: "#/components/schemas/Contact" } } },
                },
              },
            },
          },
        },
      },
    },

    "/api/companies/{id}/deals": {
      get: {
        tags: ["Companies"],
        summary: "Get deals for a company",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Deals list.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { deals: { type: "array", items: { $ref: "#/components/schemas/Deal" } } },
                },
              },
            },
          },
        },
      },
    },

    // =========================================================================
    // TASKS
    // =========================================================================
    "/api/tasks/assignees": {
      get: {
        tags: ["Tasks"],
        summary: "List task assignees",
        description: "Reps only see themselves. Directors/admins see active users in the current office.",
        responses: {
          200: {
            description: "Assignable users.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    users: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string", format: "uuid" },
                          displayName: { type: "string" },
                        },
                        required: ["id", "displayName"],
                      },
                    },
                  },
                  required: ["users"],
                },
              },
            },
          },
        },
      },
    },

    "/api/tasks": {
      get: {
        tags: ["Tasks"],
        summary: "List tasks",
        description: "Reps see only tasks assigned to them. Directors/admins see all tasks.",
        parameters: [
          { name: "assignedTo", in: "query", schema: { type: "string", format: "uuid" }, description: "Filter by assignee. Ignored for reps (forced to own ID)." },
          { name: "status", in: "query", schema: { type: "string", enum: ["pending", "scheduled", "in_progress", "waiting_on", "blocked", "completed", "dismissed"] } },
          { name: "type", in: "query", schema: { type: "string" } },
          { name: "dealId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "contactId", in: "query", schema: { type: "string", format: "uuid" } },
          {
            name: "section",
            in: "query",
            schema: { type: "string", enum: ["overdue", "today", "upcoming", "completed"] },
            description: "Convenience filter — returns tasks bucketed by due date section.",
          },
          { $ref: "#/components/parameters/PageParam" },
          { $ref: "#/components/parameters/LimitParam" },
        ],
        responses: {
          200: {
            description: "Paginated task list.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedResult" },
                    { type: "object", properties: { tasks: { type: "array", items: { $ref: "#/components/schemas/Task" } } } },
                  ],
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Tasks"],
        summary: "Create a task",
        description: "Reps can only create tasks assigned to themselves.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  type: { type: "string", enum: ["manual", "follow_up", "approval", "email_reply", "stage_action"], default: "manual" },
                  priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
                  assignedTo: { type: "string", format: "uuid", description: "Director/admin only. Reps are always self-assigned." },
                  dealId: { type: "string", format: "uuid" },
                  contactId: { type: "string", format: "uuid" },
                  dueDate: { type: "string", format: "date" },
                  dueTime: { type: "string", example: "09:00:00" },
                  remindAt: { type: "string", format: "date-time" },
                },
                required: ["title"],
              },
            },
          },
        },
        responses: {
          201: {
            description: "Task created.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { task: { $ref: "#/components/schemas/Task" } } },
              },
            },
          },
          400: { description: "Title is required." },
        },
      },
    },

    "/api/tasks/counts": {
      get: {
        tags: ["Tasks"],
        summary: "Get task counts per section",
        parameters: [
          { name: "userId", in: "query", schema: { type: "string", format: "uuid" }, description: "Director/admin only — query counts for another user." },
        ],
        responses: {
          200: {
            description: "Counts by section.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { counts: { $ref: "#/components/schemas/TaskCounts" } },
                },
              },
            },
          },
        },
      },
    },

    "/api/tasks/{id}": {
      get: {
        tags: ["Tasks"],
        summary: "Get a task by ID",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Task.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { task: { $ref: "#/components/schemas/Task" } } },
              },
            },
          },
          404: { description: "Task not found." },
        },
      },
      patch: {
        tags: ["Tasks"],
        summary: "Update task fields",
        description: "Reps cannot change assignedTo.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
                  assignedTo: { type: "string", format: "uuid", description: "Director/admin only." },
                  dueDate: { type: "string", format: "date" },
                  dueTime: { type: "string" },
                  remindAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Updated task.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { task: { $ref: "#/components/schemas/Task" } } },
              },
            },
          },
          404: { description: "Task not found." },
        },
      },
    },

    "/api/tasks/{id}/transition": {
      post: {
        tags: ["Tasks"],
        summary: "Transition a task lifecycle state",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    type: "object",
                    properties: {
                      nextStatus: { type: "string", enum: ["scheduled"] },
                      scheduledFor: { type: "string", format: "date-time" },
                    },
                    required: ["nextStatus", "scheduledFor"],
                  },
                  {
                    type: "object",
                    properties: {
                      nextStatus: { type: "string", enum: ["waiting_on"] },
                      waitingOn: { type: "object", additionalProperties: true },
                    },
                    required: ["nextStatus", "waitingOn"],
                  },
                  {
                    type: "object",
                    properties: {
                      nextStatus: { type: "string", enum: ["blocked"] },
                      blockedBy: { type: "object", additionalProperties: true },
                    },
                    required: ["nextStatus", "blockedBy"],
                  },
                  {
                    type: "object",
                    properties: {
                      nextStatus: { type: "string", enum: ["pending", "in_progress", "completed", "dismissed"] },
                      scheduledFor: { type: "string", format: "date-time", nullable: true },
                      waitingOn: { type: "object", nullable: true, additionalProperties: true },
                      blockedBy: { type: "object", nullable: true, additionalProperties: true },
                    },
                    required: ["nextStatus"],
                  },
                ],
              },
            },
          },
        },
        responses: {
          200: {
            description: "Task transitioned.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { task: { $ref: "#/components/schemas/Task" } } },
              },
            },
          },
          400: { description: "Invalid transition payload." },
          403: { description: "Access denied." },
          404: { description: "Task not found." },
        },
      },
    },

    "/api/tasks/{id}/complete": {
      post: {
        tags: ["Tasks"],
        summary: "Mark a task as completed",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Task completed.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { task: { $ref: "#/components/schemas/Task" } } },
              },
            },
          },
          403: { description: "Access denied." },
          404: { description: "Task not found." },
        },
      },
    },

    "/api/tasks/{id}/dismiss": {
      post: {
        tags: ["Tasks"],
        summary: "Dismiss a task",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Task dismissed.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { task: { $ref: "#/components/schemas/Task" } } },
              },
            },
          },
        },
      },
    },

    "/api/tasks/{id}/snooze": {
      post: {
        tags: ["Tasks"],
        summary: "Snooze a task to a new due date",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  dueDate: { type: "string", format: "date", description: "New due date to snooze until." },
                },
                required: ["dueDate"],
              },
            },
          },
        },
        responses: {
          200: {
            description: "Task snoozed.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { task: { $ref: "#/components/schemas/Task" } } },
              },
            },
          },
          400: { description: "dueDate is required." },
        },
      },
    },

    // =========================================================================
    // ACTIVITIES
    // =========================================================================
    "/api/activities": {
      get: {
        tags: ["Activities"],
        summary: "List activities",
        description: "Reps see only their own activities. Filter by dealId, contactId, or type.",
        parameters: [
          { name: "dealId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "contactId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "userId", in: "query", schema: { type: "string", format: "uuid" }, description: "Director/admin only." },
          { name: "type", in: "query", schema: { type: "string", enum: ["call", "email", "note", "meeting", "site_visit", "text"] } },
          { $ref: "#/components/parameters/PageParam" },
          { $ref: "#/components/parameters/LimitParam" },
        ],
        responses: {
          200: {
            description: "Paginated activity list.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedResult" },
                    { type: "object", properties: { activities: { type: "array", items: { $ref: "#/components/schemas/Activity" } } } },
                  ],
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Activities"],
        summary: "Log an activity",
        description: "At least one of contactId or dealId must be provided.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["call", "email", "note", "meeting", "site_visit", "text"] },
                  dealId: { type: "string", format: "uuid" },
                  contactId: { type: "string", format: "uuid" },
                  subject: { type: "string" },
                  body: { type: "string" },
                  outcome: { type: "string" },
                  durationMinutes: { type: "integer" },
                  occurredAt: { type: "string", format: "date-time" },
                },
                required: ["type"],
              },
            },
          },
        },
        responses: {
          201: {
            description: "Activity created.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { activity: { $ref: "#/components/schemas/Activity" } } },
              },
            },
          },
          400: { description: "type is required, and at least one of contactId or dealId must be provided." },
        },
      },
    },

    // =========================================================================
    // FILES
    // =========================================================================
    "/api/files/upload-url": {
      post: {
        tags: ["Files"],
        summary: "Request a presigned R2 upload URL (Step 1)",
        description: "Returns a presigned PUT URL and an uploadToken. Client uploads the file directly to R2, then calls /confirm-upload.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  originalFilename: { type: "string", example: "bid-package.pdf" },
                  mimeType: { type: "string", example: "application/pdf" },
                  fileSizeBytes: { type: "integer", example: 2048000 },
                  category: { type: "string", enum: ["photo", "document", "drawing", "bid", "contract", "change_order", "report", "other"] },
                  subcategory: { type: "string" },
                  dealId: { type: "string", format: "uuid" },
                  contactId: { type: "string", format: "uuid" },
                  procoreProjectId: { type: "integer" },
                  changeOrderId: { type: "string", format: "uuid" },
                  description: { type: "string" },
                  tags: { type: "array", items: { type: "string" } },
                },
                required: ["originalFilename", "mimeType", "fileSizeBytes", "category"],
              },
            },
          },
        },
        responses: {
          200: {
            description: "Presigned URL + upload token.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    uploadUrl: { type: "string", format: "uri", description: "PUT this URL to upload the file to R2." },
                    uploadToken: { type: "string", description: "Opaque token to pass to /confirm-upload after upload." },
                    expiresAt: { type: "string", format: "date-time" },
                  },
                  required: ["uploadUrl", "uploadToken"],
                },
              },
            },
          },
          400: { description: "Missing required fields or invalid category." },
          403: { description: "No access to the specified deal." },
        },
      },
    },

    "/api/files/confirm-upload": {
      post: {
        tags: ["Files"],
        summary: "Confirm file upload and record metadata (Step 2)",
        description: "Call after successfully uploading to R2 presigned URL. Creates the file record in the database.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  uploadToken: { type: "string", description: "Token from /upload-url response." },
                  takenAt: { type: "string", format: "date-time", description: "For photos — when the photo was taken." },
                  geoLat: { type: "number" },
                  geoLng: { type: "number" },
                },
                required: ["uploadToken"],
              },
            },
          },
        },
        responses: {
          201: {
            description: "File record created.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { file: { $ref: "#/components/schemas/File" } } },
              },
            },
          },
          400: { description: "uploadToken is required." },
        },
      },
    },

    "/api/files": {
      get: {
        tags: ["Files"],
        summary: "List files",
        description: "Reps must provide dealId or contactId. Directors/admins can list all office files.",
        parameters: [
          { name: "dealId", in: "query", schema: { type: "string", format: "uuid" }, description: "Required for reps unless contactId is provided." },
          { name: "contactId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "procoreProjectId", in: "query", schema: { type: "integer" } },
          { name: "changeOrderId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "category", in: "query", schema: { type: "string", enum: ["photo", "document", "drawing", "bid", "contract", "change_order", "report", "other"] } },
          { name: "folderPath", in: "query", schema: { type: "string" } },
          { name: "search", in: "query", schema: { type: "string" } },
          { name: "tags", in: "query", schema: { type: "string" }, description: "Comma-separated tag list." },
          { name: "sortBy", in: "query", schema: { type: "string", enum: ["display_name", "created_at", "file_size_bytes", "taken_at"] } },
          { $ref: "#/components/parameters/SortDirParam" },
          { $ref: "#/components/parameters/PageParam" },
          { $ref: "#/components/parameters/LimitParam" },
        ],
        responses: {
          200: {
            description: "Paginated file list.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedResult" },
                    { type: "object", properties: { files: { type: "array", items: { $ref: "#/components/schemas/File" } } } },
                  ],
                },
              },
            },
          },
          400: { description: "dealId or contactId filter required for reps." },
        },
      },
    },

    "/api/files/tags": {
      get: {
        tags: ["Files"],
        summary: "Get tag autocomplete suggestions",
        parameters: [
          { name: "dealId", in: "query", schema: { type: "string", format: "uuid" }, description: "Scope suggestions to a deal." },
        ],
        responses: {
          200: {
            description: "Tag suggestions.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } },
              },
            },
          },
        },
      },
    },

    "/api/files/deal/{dealId}/folders": {
      get: {
        tags: ["Files"],
        summary: "Get virtual folder tree for a deal",
        parameters: [{ name: "dealId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Folder tree.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    folders: { type: "array", items: { type: "object", additionalProperties: true } },
                  },
                },
              },
            },
          },
          404: { description: "Deal not found." },
        },
      },
    },

    "/api/files/deal/{dealId}/photos": {
      get: {
        tags: ["Files"],
        summary: "Get photo timeline for a deal",
        parameters: [
          { name: "dealId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { $ref: "#/components/parameters/PageParam" },
          { $ref: "#/components/parameters/LimitParam" },
        ],
        responses: {
          200: {
            description: "Paginated photo list (sorted by takenAt desc).",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedResult" },
                    { type: "object", properties: { files: { type: "array", items: { $ref: "#/components/schemas/File" } } } },
                  ],
                },
              },
            },
          },
          404: { description: "Deal not found." },
        },
      },
    },

    "/api/files/{id}": {
      get: {
        tags: ["Files"],
        summary: "Get file metadata by ID",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "File.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { file: { $ref: "#/components/schemas/File" } } },
              },
            },
          },
          403: { description: "Access denied." },
          404: { description: "File not found." },
        },
      },
      patch: {
        tags: ["Files"],
        summary: "Update file metadata",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  displayName: { type: "string" },
                  description: { type: "string" },
                  notes: { type: "string" },
                  tags: { type: "array", items: { type: "string" } },
                  category: { type: "string" },
                  subcategory: { type: "string" },
                  folderPath: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Updated file.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { file: { $ref: "#/components/schemas/File" } } },
              },
            },
          },
          403: { description: "Access denied." },
          404: { description: "File not found." },
        },
      },
      delete: {
        tags: ["Files"],
        summary: "Soft-delete a file",
        description: "Reps can only delete files they uploaded. Directors/admins can delete any deal file.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: { description: "Deleted.", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessResponse" } } } },
          403: { description: "Access denied." },
          404: { description: "File not found." },
        },
      },
    },

    "/api/files/{id}/download": {
      get: {
        tags: ["Files"],
        summary: "Get presigned download URL for a file",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Presigned download URL.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    downloadUrl: { type: "string", format: "uri" },
                    expiresAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          403: { description: "Access denied." },
          404: { description: "File not found." },
        },
      },
    },

    "/api/files/{id}/versions": {
      get: {
        tags: ["Files"],
        summary: "Get version history for a file",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Version chain.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { versions: { type: "array", items: { $ref: "#/components/schemas/File" } } },
                },
              },
            },
          },
          403: { description: "Access denied." },
          404: { description: "File not found." },
        },
      },
    },

    "/api/files/{id}/new-version": {
      post: {
        tags: ["Files"],
        summary: "Upload a new version of a file (Step 1)",
        description: "Returns a presigned URL for the new version. After uploading, call /confirm-upload with the returned uploadToken.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" }, description: "Parent file ID." }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  originalFilename: { type: "string" },
                  mimeType: { type: "string" },
                  fileSizeBytes: { type: "integer" },
                  category: { type: "string" },
                  subcategory: { type: "string" },
                  tags: { type: "array", items: { type: "string" } },
                },
                required: ["originalFilename", "mimeType", "fileSizeBytes"],
              },
            },
          },
        },
        responses: {
          200: {
            description: "Presigned URL + token for new version.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    uploadUrl: { type: "string", format: "uri" },
                    uploadToken: { type: "string" },
                    version: { type: "integer", description: "New version number." },
                  },
                },
              },
            },
          },
          403: { description: "Access denied." },
          404: { description: "Parent file not found." },
        },
      },
    },

    // =========================================================================
    // EMAIL
    // =========================================================================
    "/api/email/send": {
      post: {
        tags: ["Email"],
        summary: "Send an email via MS Graph",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  to: { type: "array", items: { type: "string", format: "email" }, minItems: 1 },
                  cc: { type: "array", items: { type: "string", format: "email" } },
                  subject: { type: "string" },
                  bodyHtml: { type: "string", description: "HTML email body." },
                  dealId: { type: "string", format: "uuid", description: "Associate email with a deal." },
                  contactId: { type: "string", format: "uuid", description: "Associate email with a contact." },
                },
                required: ["to", "subject", "bodyHtml"],
              },
            },
          },
        },
        responses: {
          201: {
            description: "Email sent.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { email: { $ref: "#/components/schemas/Email" } } },
              },
            },
          },
          400: { description: "Validation error — missing required fields." },
          404: { description: "Deal not found." },
        },
      },
    },

    "/api/email": {
      get: {
        tags: ["Email"],
        summary: "Get current user's email inbox",
        parameters: [
          { name: "direction", in: "query", schema: { type: "string", enum: ["inbound", "outbound"] } },
          { name: "search", in: "query", schema: { type: "string" } },
          { $ref: "#/components/parameters/PageParam" },
          { $ref: "#/components/parameters/LimitParam" },
        ],
        responses: {
          200: {
            description: "Paginated email list.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedResult" },
                    { type: "object", properties: { emails: { type: "array", items: { $ref: "#/components/schemas/Email" } } } },
                  ],
                },
              },
            },
          },
        },
      },
    },

    "/api/email/deal/{dealId}": {
      get: {
        tags: ["Email"],
        summary: "Get emails for a specific deal",
        parameters: [
          { name: "dealId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "direction", in: "query", schema: { type: "string", enum: ["inbound", "outbound"] } },
          { name: "search", in: "query", schema: { type: "string" } },
          { $ref: "#/components/parameters/PageParam" },
          { $ref: "#/components/parameters/LimitParam" },
        ],
        responses: {
          200: {
            description: "Deal emails.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedResult" },
                    { type: "object", properties: { emails: { type: "array", items: { $ref: "#/components/schemas/Email" } } } },
                  ],
                },
              },
            },
          },
          404: { description: "Deal not found." },
        },
      },
    },

    "/api/email/contact/{contactId}": {
      get: {
        tags: ["Email"],
        summary: "Get emails for a specific contact",
        parameters: [
          { name: "contactId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "direction", in: "query", schema: { type: "string", enum: ["inbound", "outbound"] } },
          { name: "search", in: "query", schema: { type: "string" } },
          { $ref: "#/components/parameters/PageParam" },
          { $ref: "#/components/parameters/LimitParam" },
        ],
        responses: {
          200: {
            description: "Contact emails.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedResult" },
                    { type: "object", properties: { emails: { type: "array", items: { $ref: "#/components/schemas/Email" } } } },
                  ],
                },
              },
            },
          },
        },
      },
    },

    "/api/email/thread/{conversationId}": {
      get: {
        tags: ["Email"],
        summary: "Get all emails in a thread",
        parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string" }, description: "MS Graph conversation ID." }],
        responses: {
          200: {
            description: "Thread emails.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { emails: { type: "array", items: { $ref: "#/components/schemas/Email" } } },
                },
              },
            },
          },
        },
      },
    },

    "/api/email/{id}": {
      get: {
        tags: ["Email"],
        summary: "Get a single email with full body",
        description: "Only the email owner or a director/admin can view.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Email.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { email: { $ref: "#/components/schemas/Email" } } },
              },
            },
          },
          403: { description: "Permission denied." },
          404: { description: "Email not found." },
        },
      },
    },

    "/api/email/{id}/associate": {
      post: {
        tags: ["Email"],
        summary: "Manually associate an email with a deal",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  dealId: { type: "string", format: "uuid" },
                },
                required: ["dealId"],
              },
            },
          },
        },
        responses: {
          200: { description: "Associated.", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessResponse" } } } },
          400: { description: "dealId is required." },
          403: { description: "Permission denied." },
          404: { description: "Email or deal not found." },
        },
      },
    },

    // =========================================================================
    // REPORTS
    // =========================================================================
    "/api/reports/pipeline-summary": {
      get: {
        tags: ["Reports"],
        summary: "Pipeline summary by stage",
        description: "Returns deal counts and values grouped by stage. Reps see only their own data.",
        parameters: [
          { name: "includeDd", in: "query", schema: { type: "boolean", default: false } },
          { $ref: "#/components/parameters/DateFromParam" },
          { $ref: "#/components/parameters/DateToParam" },
        ],
        responses: {
          200: {
            description: "Pipeline summary.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { data: { type: "array", items: { type: "object", additionalProperties: true } } },
                },
              },
            },
          },
        },
      },
    },

    "/api/reports/weighted-forecast": {
      get: {
        tags: ["Reports"],
        summary: "Weighted pipeline forecast",
        description: "Deal values weighted by win probability per stage. Reps see only their own data.",
        parameters: [
          { $ref: "#/components/parameters/DateFromParam" },
          { $ref: "#/components/parameters/DateToParam" },
        ],
        responses: {
          200: {
            description: "Forecast data.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { data: { type: "object", additionalProperties: true } } },
              },
            },
          },
        },
      },
    },

    "/api/reports/win-loss": {
      get: {
        tags: ["Reports"],
        summary: "Win/loss ratio by rep (director/admin only)",
        parameters: [
          { $ref: "#/components/parameters/DateFromParam" },
          { $ref: "#/components/parameters/DateToParam" },
        ],
        responses: {
          200: {
            description: "Win/loss ratios.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { data: { type: "array", items: { type: "object", additionalProperties: true } } } },
              },
            },
          },
          403: { description: "Director or admin role required." },
        },
      },
    },

    "/api/reports/win-rate-trend": {
      get: {
        tags: ["Reports"],
        summary: "Win rate trend over time",
        parameters: [
          { $ref: "#/components/parameters/DateFromParam" },
          { $ref: "#/components/parameters/DateToParam" },
          { name: "repId", in: "query", schema: { type: "string", format: "uuid" }, description: "Director/admin only." },
        ],
        responses: {
          200: {
            description: "Trend data.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { data: { type: "array", items: { type: "object", additionalProperties: true } } } },
              },
            },
          },
        },
      },
    },

    "/api/reports/activity-summary": {
      get: {
        tags: ["Reports"],
        summary: "Activity summary by rep (director/admin only)",
        parameters: [
          { $ref: "#/components/parameters/DateFromParam" },
          { $ref: "#/components/parameters/DateToParam" },
        ],
        responses: {
          200: {
            description: "Activity summary.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { data: { type: "array", items: { type: "object", additionalProperties: true } } } },
              },
            },
          },
          403: { description: "Director or admin role required." },
        },
      },
    },

    "/api/reports/stale-deals": {
      get: {
        tags: ["Reports"],
        summary: "Deals with no recent activity",
        parameters: [
          { name: "repId", in: "query", schema: { type: "string", format: "uuid" }, description: "Director/admin only." },
        ],
        responses: {
          200: {
            description: "Stale deal list.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/Deal" } } } },
              },
            },
          },
        },
      },
    },

    "/api/reports/lost-by-reason": {
      get: {
        tags: ["Reports"],
        summary: "Lost deals grouped by reason",
        parameters: [
          { $ref: "#/components/parameters/DateFromParam" },
          { $ref: "#/components/parameters/DateToParam" },
        ],
        responses: {
          200: {
            description: "Lost deals by reason.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { data: { type: "array", items: { type: "object", additionalProperties: true } } } },
              },
            },
          },
        },
      },
    },

    "/api/reports/revenue-by-type": {
      get: {
        tags: ["Reports"],
        summary: "Revenue grouped by project type (director/admin only)",
        parameters: [
          { $ref: "#/components/parameters/DateFromParam" },
          { $ref: "#/components/parameters/DateToParam" },
        ],
        responses: {
          200: {
            description: "Revenue by project type.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { data: { type: "array", items: { type: "object", additionalProperties: true } } } },
              },
            },
          },
          403: { description: "Director or admin role required." },
        },
      },
    },

    "/api/reports/lead-source-roi": {
      get: {
        tags: ["Reports"],
        summary: "Lead source ROI breakdown (director/admin only)",
        parameters: [
          { $ref: "#/components/parameters/DateFromParam" },
          { $ref: "#/components/parameters/DateToParam" },
        ],
        responses: {
          200: {
            description: "Lead source ROI.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { data: { type: "array", items: { type: "object", additionalProperties: true } } } },
              },
            },
          },
          403: { description: "Director or admin role required." },
        },
      },
    },

    "/api/reports/follow-up-compliance": {
      get: {
        tags: ["Reports"],
        summary: "Follow-up compliance rate",
        description: "Measures whether reps follow up within target SLA. Reps see only their own data.",
        parameters: [
          { name: "repId", in: "query", schema: { type: "string", format: "uuid" } },
          { $ref: "#/components/parameters/DateFromParam" },
          { $ref: "#/components/parameters/DateToParam" },
        ],
        responses: {
          200: {
            description: "Compliance data.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { data: { type: "object", additionalProperties: true } } },
              },
            },
          },
        },
      },
    },

    "/api/reports/dd-vs-pipeline": {
      get: {
        tags: ["Reports"],
        summary: "DD estimates vs. pipeline values comparison",
        responses: {
          200: {
            description: "DD vs pipeline data.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { data: { type: "object", additionalProperties: true } } },
              },
            },
          },
        },
      },
    },

    "/api/reports/execute": {
      post: {
        tags: ["Reports"],
        summary: "Execute a custom report config",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  config: { $ref: "#/components/schemas/ReportConfig" },
                  page: { type: "integer", default: 1 },
                  limit: { type: "integer", default: 100 },
                },
                required: ["config"],
              },
            },
          },
        },
        responses: {
          200: {
            description: "Report results.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedResult" },
                    { type: "object", properties: { rows: { type: "array", items: { type: "object", additionalProperties: true } } } },
                  ],
                },
              },
            },
          },
          400: { description: "config with entity is required." },
        },
      },
    },

    "/api/reports/saved": {
      get: {
        tags: ["Reports"],
        summary: "List saved reports visible to current user",
        responses: {
          200: {
            description: "Saved reports.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { reports: { type: "array", items: { $ref: "#/components/schemas/SavedReport" } } },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Reports"],
        summary: "Create a saved report",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  entity: { type: "string", enum: ["deals", "contacts", "activities", "tasks"] },
                  config: { $ref: "#/components/schemas/ReportConfig" },
                  visibility: { type: "string", enum: ["private", "office", "locked"] },
                },
                required: ["name", "entity", "config"],
              },
            },
          },
        },
        responses: {
          201: {
            description: "Report created.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { report: { $ref: "#/components/schemas/SavedReport" } } },
              },
            },
          },
          400: { description: "name, entity, and config are required." },
        },
      },
    },

    "/api/reports/saved/{id}": {
      get: {
        tags: ["Reports"],
        summary: "Get a single saved report",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Saved report.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { report: { $ref: "#/components/schemas/SavedReport" } } },
              },
            },
          },
          404: { description: "Report not found." },
        },
      },
      patch: {
        tags: ["Reports"],
        summary: "Update a saved report",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  config: { $ref: "#/components/schemas/ReportConfig" },
                  visibility: { type: "string", enum: ["private", "office", "locked"] },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Updated report.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { report: { $ref: "#/components/schemas/SavedReport" } } },
              },
            },
          },
        },
      },
      delete: {
        tags: ["Reports"],
        summary: "Delete a saved report",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: { description: "Deleted.", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessResponse" } } } },
          403: { description: "Only the creator can delete their report." },
        },
      },
    },

    "/api/reports/seed": {
      post: {
        tags: ["Reports"],
        summary: "Seed locked reports for office (admin only)",
        responses: {
          200: {
            description: "Seeded.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    message: { type: "string" },
                  },
                },
              },
            },
          },
          403: { description: "Admin role required." },
        },
      },
    },

    // =========================================================================
    // DASHBOARD
    // =========================================================================
    "/api/dashboard/rep": {
      get: {
        tags: ["Dashboard"],
        summary: "Get rep dashboard for current user",
        description: "Returns the logged-in rep's personal dashboard: task counts, recent deals, activity streak, etc.",
        responses: {
          200: {
            description: "Rep dashboard data.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      additionalProperties: true,
                      description: "Dashboard aggregations — structure depends on implemented metrics.",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/api/dashboard/director": {
      get: {
        tags: ["Dashboard"],
        summary: "Get director overview dashboard (director/admin only)",
        parameters: [
          { $ref: "#/components/parameters/DateFromParam" },
          { $ref: "#/components/parameters/DateToParam" },
        ],
        responses: {
          200: {
            description: "Director dashboard.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { data: { type: "object", additionalProperties: true } },
                },
              },
            },
          },
          403: { description: "Director or admin role required." },
        },
      },
    },

    "/api/dashboard/director/rep/{repId}": {
      get: {
        tags: ["Dashboard"],
        summary: "Drill-down dashboard for a specific rep (director/admin only)",
        parameters: [
          { name: "repId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { $ref: "#/components/parameters/DateFromParam" },
          { $ref: "#/components/parameters/DateToParam" },
        ],
        responses: {
          200: {
            description: "Rep detail dashboard.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { data: { type: "object", additionalProperties: true } },
                },
              },
            },
          },
          403: { description: "Director or admin role required." },
        },
      },
    },

    // =========================================================================
    // PIPELINE CONFIG
    // =========================================================================
    "/api/pipeline/stages": {
      get: {
        tags: ["Pipeline"],
        summary: "Get all pipeline stages (ordered)",
        responses: {
          200: {
            description: "Ordered stage list.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    stages: { type: "array", items: { $ref: "#/components/schemas/PipelineStage" } },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/api/pipeline/lost-reasons": {
      get: {
        tags: ["Pipeline"],
        summary: "Get active lost deal reasons",
        responses: {
          200: {
            description: "Lost reasons.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    reasons: { type: "array", items: { $ref: "#/components/schemas/LostReason" } },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/api/pipeline/project-types": {
      get: {
        tags: ["Pipeline"],
        summary: "Get active project types (hierarchical)",
        responses: {
          200: {
            description: "Project types.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    projectTypes: { type: "array", items: { $ref: "#/components/schemas/ProjectType" } },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/api/pipeline/regions": {
      get: {
        tags: ["Pipeline"],
        summary: "Get active regions",
        responses: {
          200: {
            description: "Regions.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    regions: { type: "array", items: { $ref: "#/components/schemas/Region" } },
                  },
                },
              },
            },
          },
        },
      },
    },

    // =========================================================================
    // SEARCH
    // =========================================================================
    "/api/search": {
      get: {
        tags: ["Search"],
        summary: "Global cross-entity search",
        description: "Searches deals, contacts, and/or files. Minimum 2 characters. Returns grouped results.",
        parameters: [
          {
            name: "q",
            in: "query",
            required: true,
            schema: { type: "string", minLength: 2 },
            description: "Search query (minimum 2 characters).",
          },
          {
            name: "types",
            in: "query",
            schema: { type: "string" },
            description: "Comma-separated entity types to search. Defaults to all: deals,contacts,files.",
          },
        ],
        responses: {
          200: {
            description: "Grouped search results.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    deals: { type: "array", items: { $ref: "#/components/schemas/Deal" } },
                    contacts: { type: "array", items: { $ref: "#/components/schemas/Contact" } },
                    files: { type: "array", items: { $ref: "#/components/schemas/File" } },
                    total: { type: "integer" },
                    query: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },

    // =========================================================================
    // NOTIFICATIONS
    // =========================================================================
    "/api/notifications/stream": {
      get: {
        tags: ["Notifications"],
        summary: "Subscribe to real-time notification stream (SSE)",
        description: "Server-Sent Events endpoint. Connect with EventSource. Sends `connected` event on open, then `notification` events as they fire. Keepalive comment every 30s.",
        responses: {
          200: {
            description: "SSE stream (text/event-stream).",
            content: {
              "text/event-stream": {
                schema: { type: "string" },
              },
            },
          },
          401: { description: "Not authenticated." },
        },
      },
    },

    "/api/notifications/list": {
      get: {
        tags: ["Notifications"],
        summary: "List notifications for current user",
        parameters: [
          { name: "isRead", in: "query", schema: { type: "boolean" }, description: "Filter by read status." },
          { $ref: "#/components/parameters/PageParam" },
          { $ref: "#/components/parameters/LimitParam" },
        ],
        responses: {
          200: {
            description: "Paginated notification list.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedResult" },
                    {
                      type: "object",
                      properties: {
                        notifications: { type: "array", items: { $ref: "#/components/schemas/Notification" } },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },

    "/api/notifications/unread-count": {
      get: {
        tags: ["Notifications"],
        summary: "Get unread notification count for current user",
        responses: {
          200: {
            description: "Unread count.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { count: { type: "integer" } },
                },
              },
            },
          },
        },
      },
    },

    "/api/notifications/{id}/read": {
      post: {
        tags: ["Notifications"],
        summary: "Mark a notification as read",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Notification marked read.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { notification: { $ref: "#/components/schemas/Notification" } },
                },
              },
            },
          },
          404: { description: "Notification not found." },
        },
      },
    },

    "/api/notifications/read-all": {
      post: {
        tags: ["Notifications"],
        summary: "Mark all notifications as read",
        responses: {
          200: {
            description: "All marked read.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { markedRead: { type: "integer", description: "Number of notifications marked read." } },
                },
              },
            },
          },
        },
      },
    },

    // =========================================================================
    // ADMIN
    // =========================================================================
    "/api/admin/offices": {
      get: {
        tags: ["Admin"],
        summary: "List all offices (admin only)",
        responses: {
          200: {
            description: "Office list.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { offices: { type: "array", items: { $ref: "#/components/schemas/Office" } } } },
              },
            },
          },
          403: { description: "Admin role required." },
        },
      },
      post: {
        tags: ["Admin"],
        summary: "Create an office (admin only)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  slug: { type: "string", description: "Used as the database schema name prefix (e.g. 'dallas' → office_dallas)." },
                  address: { type: "string" },
                  phone: { type: "string" },
                },
                required: ["name", "slug"],
              },
            },
          },
        },
        responses: {
          201: {
            description: "Office created.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { office: { $ref: "#/components/schemas/Office" } } },
              },
            },
          },
          400: { description: "name and slug required." },
          403: { description: "Admin role required." },
        },
      },
    },

    "/api/admin/offices/{id}": {
      get: {
        tags: ["Admin"],
        summary: "Get an office by ID (admin only)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Office.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { office: { $ref: "#/components/schemas/Office" } } },
              },
            },
          },
          404: { description: "Office not found." },
        },
      },
      patch: {
        tags: ["Admin"],
        summary: "Update an office (admin only)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  address: { type: "string" },
                  phone: { type: "string" },
                  isActive: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Updated office.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { office: { $ref: "#/components/schemas/Office" } } },
              },
            },
          },
        },
      },
    },

    "/api/admin/users": {
      get: {
        tags: ["Admin"],
        summary: "List all users with stats (admin only)",
        responses: {
          200: {
            description: "User list.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { users: { type: "array", items: { $ref: "#/components/schemas/User" } } } },
              },
            },
          },
          403: { description: "Admin role required." },
        },
      },
    },

    "/api/admin/users/{id}": {
      get: {
        tags: ["Admin"],
        summary: "Get a user by ID (admin only)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "User.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { user: { $ref: "#/components/schemas/User" } } },
              },
            },
          },
          404: { description: "User not found." },
        },
      },
      patch: {
        tags: ["Admin"],
        summary: "Update a user (admin only)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  displayName: { type: "string" },
                  role: { type: "string", enum: ["admin", "director", "rep"] },
                  isActive: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Updated user.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { user: { $ref: "#/components/schemas/User" } } },
              },
            },
          },
        },
      },
    },

    "/api/admin/users/{id}/office-access": {
      post: {
        tags: ["Admin"],
        summary: "Grant a user access to an office (admin only)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  officeId: { type: "string", format: "uuid" },
                  roleOverride: { type: "string", enum: ["admin", "director", "rep"] },
                },
                required: ["officeId"],
              },
            },
          },
        },
        responses: {
          200: { description: "Access granted.", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessResponse" } } } },
          400: { description: "officeId required." },
        },
      },
    },

    "/api/admin/users/{id}/office-access/{officeId}": {
      delete: {
        tags: ["Admin"],
        summary: "Revoke a user's access to an office (admin only)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "officeId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          200: { description: "Access revoked.", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessResponse" } } } },
        },
      },
    },

    "/api/admin/pipeline": {
      get: {
        tags: ["Admin"],
        summary: "List pipeline stage configurations (admin only)",
        responses: {
          200: {
            description: "Stage configs.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { stages: { type: "array", items: { $ref: "#/components/schemas/PipelineStage" } } },
                },
              },
            },
          },
          403: { description: "Admin role required." },
        },
      },
    },

    "/api/admin/pipeline/{id}": {
      patch: {
        tags: ["Admin"],
        summary: "Update a pipeline stage configuration (admin only)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  color: { type: "string" },
                  probability: { type: "integer", minimum: 0, maximum: 100 },
                  isActive: { type: "boolean" },
                  requiresApproval: { type: "boolean" },
                  approvalRole: { type: "string", enum: ["director", "admin"] },
                  procoreStageMapping: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Updated stage.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { stage: { $ref: "#/components/schemas/PipelineStage" } } },
              },
            },
          },
        },
      },
    },

    "/api/admin/pipeline/reorder": {
      post: {
        tags: ["Admin"],
        summary: "Reorder pipeline stages (admin only)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  orderedIds: {
                    type: "array",
                    items: { type: "string", format: "uuid" },
                    description: "Stage IDs in the desired display order.",
                  },
                },
                required: ["orderedIds"],
              },
            },
          },
        },
        responses: {
          200: { description: "Reordered.", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessResponse" } } } },
          400: { description: "orderedIds required." },
        },
      },
    },

    "/api/admin/audit": {
      get: {
        tags: ["Admin"],
        summary: "Query audit log (director/admin only)",
        parameters: [
          { name: "tableName", in: "query", schema: { type: "string" } },
          { name: "recordId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "changedBy", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "action", in: "query", schema: { type: "string", enum: ["INSERT", "UPDATE", "DELETE"] } },
          { name: "fromDate", in: "query", schema: { type: "string", format: "date" } },
          { name: "toDate", in: "query", schema: { type: "string", format: "date" } },
          { $ref: "#/components/parameters/PageParam" },
          { $ref: "#/components/parameters/LimitParam" },
        ],
        responses: {
          200: {
            description: "Paginated audit log.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedResult" },
                    {
                      type: "object",
                      properties: {
                        entries: { type: "array", items: { $ref: "#/components/schemas/AuditLogEntry" } },
                      },
                    },
                  ],
                },
              },
            },
          },
          403: { description: "Director or admin role required." },
        },
      },
    },

    "/api/admin/audit/tables": {
      get: {
        tags: ["Admin"],
        summary: "Get auditable table names (director/admin only)",
        responses: {
          200: {
            description: "Table name list.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { tables: { type: "array", items: { type: "string" } } },
                },
              },
            },
          },
          403: { description: "Director or admin role required." },
        },
      },
    },

    // =========================================================================
    // MIGRATION
    // =========================================================================
    "/api/migration/summary": {
      get: {
        tags: ["Migration"],
        summary: "Get migration dashboard summary (admin only)",
        responses: {
          200: {
            description: "Migration summary stats.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: true,
                  description: "Counts of staged records by status and entity type.",
                },
              },
            },
          },
          403: { description: "Admin role required." },
        },
      },
    },

    "/api/migration/runs": {
      get: {
        tags: ["Migration"],
        summary: "List import run history (admin only)",
        responses: {
          200: {
            description: "Import runs.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    runs: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string", format: "uuid" },
                          type: { type: "string" },
                          status: { type: "string" },
                          stats: { type: "object", additionalProperties: true },
                          error: { type: "string", nullable: true },
                          createdBy: { type: "string", format: "uuid" },
                          createdAt: { type: "string", format: "date-time" },
                          completedAt: { type: "string", format: "date-time", nullable: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          403: { description: "Admin role required." },
        },
      },
    },

    "/api/migration/validate": {
      post: {
        tags: ["Migration"],
        summary: "Validate staged data (admin only)",
        description: "Runs validation on all staged deals, contacts, and activities. Returns validation stats per entity type.",
        responses: {
          200: {
            description: "Validation results.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    runId: { type: "string", format: "uuid" },
                    stats: {
                      type: "object",
                      properties: {
                        deals: { type: "object", additionalProperties: true },
                        contacts: { type: "object", additionalProperties: true },
                        activities: { type: "object", additionalProperties: true },
                      },
                    },
                  },
                },
              },
            },
          },
          403: { description: "Admin role required." },
        },
      },
    },

    "/api/migration/deals": {
      get: {
        tags: ["Migration"],
        summary: "List staged deals (admin only)",
        parameters: [
          { name: "validationStatus", in: "query", schema: { type: "string", enum: ["valid", "invalid", "pending"] } },
          { $ref: "#/components/parameters/PageParam" },
          { $ref: "#/components/parameters/LimitParam" },
        ],
        responses: {
          200: {
            description: "Staged deals.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedResult" },
                    { type: "object", properties: { deals: { type: "array", items: { type: "object", additionalProperties: true } } } },
                  ],
                },
              },
            },
          },
        },
      },
    },

    "/api/migration/deals/{id}/approve": {
      post: {
        tags: ["Migration"],
        summary: "Approve a staged deal (admin only)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: { description: "Approved.", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessResponse" } } } },
        },
      },
    },

    "/api/migration/deals/{id}/reject": {
      post: {
        tags: ["Migration"],
        summary: "Reject a staged deal (admin only)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { notes: { type: "string" } },
              },
            },
          },
        },
        responses: {
          200: { description: "Rejected.", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessResponse" } } } },
        },
      },
    },

    "/api/migration/deals/batch-approve": {
      post: {
        tags: ["Migration"],
        summary: "Batch-approve staged deals (admin only)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ids: { type: "array", items: { type: "string", format: "uuid" }, minItems: 1 },
                },
                required: ["ids"],
              },
            },
          },
        },
        responses: {
          200: {
            description: "Batch approved.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { approved: { type: "integer" } } },
              },
            },
          },
          400: { description: "ids array required." },
        },
      },
    },

    "/api/migration/contacts": {
      get: {
        tags: ["Migration"],
        summary: "List staged contacts (admin only)",
        parameters: [
          { name: "validationStatus", in: "query", schema: { type: "string", enum: ["valid", "invalid", "duplicate", "pending"] } },
          { $ref: "#/components/parameters/PageParam" },
          { $ref: "#/components/parameters/LimitParam" },
        ],
        responses: {
          200: {
            description: "Staged contacts.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/PaginatedResult" },
                    { type: "object", properties: { contacts: { type: "array", items: { type: "object", additionalProperties: true } } } },
                  ],
                },
              },
            },
          },
        },
      },
    },

    "/api/migration/contacts/{id}/approve": {
      post: {
        tags: ["Migration"],
        summary: "Approve a staged contact (admin only)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: { description: "Approved.", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessResponse" } } } },
        },
      },
    },

    "/api/migration/contacts/{id}/reject": {
      post: {
        tags: ["Migration"],
        summary: "Reject a staged contact (admin only)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { notes: { type: "string" } } },
            },
          },
        },
        responses: {
          200: { description: "Rejected.", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessResponse" } } } },
        },
      },
    },

    "/api/migration/contacts/{id}/merge": {
      post: {
        tags: ["Migration"],
        summary: "Merge a staged contact into an existing one (admin only)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  mergeTargetId: { type: "string", format: "uuid", description: "Existing contact to merge staged data into." },
                },
                required: ["mergeTargetId"],
              },
            },
          },
        },
        responses: {
          200: { description: "Merged.", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessResponse" } } } },
          400: { description: "mergeTargetId required." },
        },
      },
    },

    "/api/migration/contacts/batch-approve": {
      post: {
        tags: ["Migration"],
        summary: "Batch-approve staged contacts (admin only)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ids: { type: "array", items: { type: "string", format: "uuid" }, minItems: 1 },
                },
                required: ["ids"],
              },
            },
          },
        },
        responses: {
          200: {
            description: "Batch approved.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { approved: { type: "integer" } } },
              },
            },
          },
          400: { description: "ids array required." },
        },
      },
    },

    // =========================================================================
    // PROCORE
    // =========================================================================
    "/api/procore/sync-status": {
      get: {
        tags: ["Procore"],
        summary: "Get Procore sync status overview (admin only)",
        description: "Returns sync state summary counts and a list of conflict records, plus circuit breaker state.",
        responses: {
          200: {
            description: "Sync status.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    summary: {
                      type: "object",
                      properties: {
                        synced: { type: "integer" },
                        pending: { type: "integer" },
                        conflict: { type: "integer" },
                        error: { type: "integer" },
                      },
                    },
                    conflicts: { type: "array", items: { $ref: "#/components/schemas/ProcoreSyncState" } },
                    circuit_breaker: {
                      type: "object",
                      properties: {
                        state: { type: "string", enum: ["closed", "open", "half-open"] },
                        failureCount: { type: "integer" },
                        lastFailureAt: { type: "string", format: "date-time", nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
          403: { description: "Admin role required." },
        },
      },
    },

    "/api/procore/sync-conflicts/{id}/resolve": {
      post: {
        tags: ["Procore"],
        summary: "Manually resolve a Procore sync conflict (admin only)",
        description: "Either push CRM data to Procore ('accept_crm') or update CRM from Procore conflict data ('accept_procore').",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  resolution: { type: "string", enum: ["accept_crm", "accept_procore"] },
                },
                required: ["resolution"],
              },
            },
          },
        },
        responses: {
          200: {
            description: "Conflict resolved.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    record: { $ref: "#/components/schemas/ProcoreSyncState" },
                  },
                },
              },
            },
          },
          400: { description: "Invalid resolution value or record not in conflict state." },
          403: { description: "Admin role required." },
          404: { description: "Sync record not found." },
        },
      },
    },

    "/api/procore/deals/{dealId}/sync-state": {
      get: {
        tags: ["Procore"],
        summary: "Get Procore sync state for a single deal",
        parameters: [{ name: "dealId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: {
            description: "Sync state record or null if not synced.",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/ProcoreSyncState" },
                    { type: "null" },
                  ],
                },
              },
            },
          },
        },
      },
    },

    "/api/procore/my-projects": {
      get: {
        tags: ["Procore"],
        summary: "Get deals linked to Procore projects",
        description: "Returns deals where procore_project_id is set. Reps see only their own; directors/admins see all.",
        responses: {
          200: {
            description: "Procore-linked deals.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    deals: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string", format: "uuid" },
                          dealNumber: { type: "string" },
                          name: { type: "string" },
                          procoreProjectId: { type: "integer" },
                          procoreLastSyncedAt: { type: "string", format: "date-time", nullable: true },
                          changeOrderTotal: { type: "string" },
                          stageName: { type: "string" },
                          stageColor: { type: "string" },
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
  },
} as const;

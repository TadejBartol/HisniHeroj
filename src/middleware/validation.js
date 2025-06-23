// =============================================================================
// Validation Middleware and Error Handlers
// =============================================================================

const Joi = require('joi');

/**
 * Validation middleware factory
 */
function validate(schema, property = 'body') {
  return (req, res, next) => {
    const { error } = schema.validate(req[property]);
    
    if (error) {
      const details = {};
      error.details.forEach(detail => {
        details[detail.path.join('.')] = detail.message;
      });
      
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Preveri vnesene podatke',
          details
        }
      });
    }
    
    next();
  };
}

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

// Auth schemas
const authSchemas = {
  register: Joi.object({
    email: Joi.string().email().required().messages({
      'string.email': 'Email naslov ni veljaven',
      'any.required': 'Email naslov je obvezen'
    }),
    password: Joi.string().min(8).required().messages({
      'string.min': 'Geslo mora imeti vsaj 8 znakov',
      'any.required': 'Geslo je obvezno'
    }),
    first_name: Joi.string().min(2).max(50).required().messages({
      'string.min': 'Ime mora imeti vsaj 2 znaka',
      'string.max': 'Ime je predolgo',
      'any.required': 'Ime je obvezno'
    }),
    last_name: Joi.string().min(2).max(50).required().messages({
      'string.min': 'Priimek mora imeti vsaj 2 znaka',
      'string.max': 'Priimek je predolg',
      'any.required': 'Priimek je obvezen'
    })
  }),

  login: Joi.object({
    email: Joi.string().email().required().messages({
      'string.email': 'Email naslov ni veljaven',
      'any.required': 'Email naslov je obvezen'
    }),
    password: Joi.string().required().messages({
      'any.required': 'Geslo je obvezno'
    })
  })
};

// Household schemas
const householdSchemas = {
  create: Joi.object({
    name: Joi.string().min(2).max(100).required().messages({
      'string.min': 'Ime gospodinjstva mora imeti vsaj 2 znaka',
      'string.max': 'Ime gospodinjstva je predolgo',
      'any.required': 'Ime gospodinjstva je obvezno'
    }),
    description: Joi.string().max(500).allow('').messages({
      'string.max': 'Opis je predolg'
    })
  }),

  join: Joi.object({
    invite_code: Joi.string().length(6).required().messages({
      'string.length': 'Invite koda mora imeti 6 znakov',
      'any.required': 'Invite koda je obvezna'
    })
  }),

  updatePermissions: Joi.object({
    role: Joi.string().valid('owner', 'admin', 'member').messages({
      'any.only': 'Vloga mora biti owner, admin ali member'
    }),
    can_create_tasks: Joi.boolean(),
    can_assign_tasks: Joi.boolean(),
    can_create_rewards: Joi.boolean()
  })
};

// Task schemas
const taskSchemas = {
  create: Joi.object({
    title: Joi.string().min(2).max(200).required().messages({
      'string.min': 'Naslov mora imeti vsaj 2 znaka',
      'string.max': 'Naslov je predolg',
      'any.required': 'Naslov je obvezen'
    }),
    description: Joi.string().max(1000).allow('').messages({
      'string.max': 'Opis je predolg'
    }),
    category_id: Joi.number().integer().positive().required().messages({
      'number.positive': 'ID kategorije mora biti pozitivno število',
      'any.required': 'Kategorija je obvezna'
    }),
    difficulty_minutes: Joi.number().integer().min(5).max(240).required().messages({
      'number.min': 'Minimalna težavnost je 5 minut',
      'number.max': 'Maksimalna težavnost je 240 minut',
      'any.required': 'Težavnost je obvezna'
    }),
    frequency: Joi.string().valid('once', 'daily', 'weekly', 'monthly', 'yearly').required().messages({
      'any.only': 'Frekvenca mora biti: once, daily, weekly, monthly, yearly',
      'any.required': 'Frekvenca je obvezna'
    }),
    specific_date: Joi.date().when('frequency', {
      is: 'yearly',
      then: Joi.required(),
      otherwise: Joi.allow(null)
    }).messages({
      'any.required': 'Za letno frekvenco je potreben specifičen datum'
    }),
    requires_proof: Joi.boolean().default(false)
  }),

  assign: Joi.object({
    assigned_to: Joi.array().items(
      Joi.number().integer().positive()
    ).min(1).required().messages({
      'array.min': 'Izbrati morate vsaj enega uporabnika',
      'any.required': 'Seznam uporabnikov je obvezen'
    }),
    due_date: Joi.date().min('now').required().messages({
      'date.min': 'Datum izvršitve ne more biti v preteklosti',
      'any.required': 'Datum izvršitve je obvezen'
    }),
    is_cyclic: Joi.boolean().default(false),
    cycle_users: Joi.array().items(
      Joi.number().integer().positive()
    ).when('is_cyclic', {
      is: true,
      then: Joi.required(),
      otherwise: Joi.allow(null)
    })
  })
};

// Completion schemas
const completionSchemas = {
  complete: Joi.object({
    comment: Joi.string().max(500).allow('').messages({
      'string.max': 'Komentar je predolg'
    })
  })
};

// User schemas
 const userSchemas = {
   updateProfile: Joi.object({
     first_name: Joi.string().min(2).max(50).required().messages({
       'string.min': 'Ime mora imeti vsaj 2 znaka',
       'string.max': 'Ime je predolgo',
       'any.required': 'Ime je obvezno'
     }),
     last_name: Joi.string().min(2).max(50).required().messages({
       'string.min': 'Priimek mora imeti vsaj 2 znaka',
       'string.max': 'Priimek je predolg',
       'any.required': 'Priimek je obvezen'
     })
   }),

   changePassword: Joi.object({
     current_password: Joi.string().required().messages({
       'any.required': 'Trenutno geslo je obvezno'
     }),
     new_password: Joi.string().min(8).required().messages({
       'string.min': 'Novo geslo mora imeti vsaj 8 znakov',
       'any.required': 'Novo geslo je obvezno'
     })
   })
 };

// Reward schemas
const rewardSchemas = {
  create: Joi.object({
    title: Joi.string().min(2).max(200).required().messages({
      'string.min': 'Naslov mora imeti vsaj 2 znaka',
      'string.max': 'Naslov je predolg',
      'any.required': 'Naslov je obvezen'
    }),
    description: Joi.string().max(1000).allow('').messages({
      'string.max': 'Opis je predolg'
    }),
    cost_points: Joi.number().integer().min(1).max(10000).required().messages({
      'number.min': 'Minimalna cena je 1 točka',
      'number.max': 'Maksimalna cena je 10000 točk',
      'any.required': 'Cena v točkah je obvezna'
    })
  })
};

// =============================================================================
// ERROR HANDLERS
// =============================================================================

/**
 * 404 Not Found handler
 */
function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: {
      code: 'RESOURCE_NOT_FOUND',
      message: 'Zahtevani vir ni najden',
      path: req.path
    }
  });
}

/**
 * Global error handler
 */
function errorHandler(error, req, res, next) {
  // Log error
  console.error('Error:', error);

  // Handle different types of errors
  if (error.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      success: false,
      error: {
        code: 'DUPLICATE_RESOURCE',
        message: 'Podatek že obstaja'
      }
    });
  }

  if (error.code === 'ER_NO_REFERENCED_ROW_2') {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_REFERENCE',
        message: 'Napačna referenca na drug vir'
      }
    });
  }

  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: {
        code: 'FILE_TOO_LARGE',
        message: 'Datoteka je prevelika'
      }
    });
  }

  if (error.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_FILE_FIELD',
        message: 'Napačno polje za datoteko'
      }
    });
  }

  // Default internal server error
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Notranja napaka strežnika'
    }
  });
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  validate,
  authSchemas,
  userSchemas,
  householdSchemas,
  taskSchemas,
  completionSchemas,
  rewardSchemas,
  notFoundHandler,
  errorHandler
}; 

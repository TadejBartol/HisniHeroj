# HisniHeroj Home Assistant Add-on

Family Tasks Manager - Družinska aplikacija za upravljanje opravil, točk in nagrad

## About

HisniHeroj je aplikacija za upravljanje družinskih opravil z:
- Registracijo uporabnikov in upravljanjem gospodinjstev
- Sistemom opravil s točkami in nagradami
- Statistikami in lestvicami
- API-jem za Flutter aplikacijo

## Installation

1. Add this repository to your Home Assistant:
   - Go to **Settings** → **Add-ons** → **Add-on Store**
   - Click **⋮** → **Repositories**
   - Add: `https://github.com/YOUR_USERNAME/hisniheroj-addon`

2. Install the add-on:
   - Find **HisniHeroj** in the add-on store
   - Click **Install**

3. Configure the database:
   - Install MariaDB add-on if not already installed
   - Create database `hisniheroj` with user `hisniheroj`

4. Configure the add-on:
   - Set your database connection details
   - Start the add-on

## Configuration

```yaml
database_host: "core-mariadb"
database_port: 5123
database_name: "hisniheroj"
database_user: "hisniheroj"
database_password: "admin123"
jwt_secret: "your-super-secret-jwt-key-change-this-in-production"
```

## API

The add-on provides a REST API on port 3000 for the Flutter mobile application.

API documentation is available in `API_SPECIFICATION.md`.

## Support

For issues and questions, please use the GitHub issues page. 
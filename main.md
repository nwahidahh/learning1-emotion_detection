# API Flowchart - Arousal-Valence Learning Platform

## Application Architecture & Flow

```mermaid
graph TD
    A[User Access] --> B{Authentication}
    B -->|New User| C["POST /auth/register"]
    B -->|Existing User| D["POST /auth/login"]
    C -->|Create Token| E["Access Token Generated"]
    D -->|Verify Password| E
    E --> F{Select Role}

    F -->|Student| S0
    F -->|Teacher| T0
    F -->|Admin| A0

    subgraph Student[Student User Flow]
        S0["Student Dashboard"] --> S1["Check Consent"]
        S1 -->|No Consent| S1A["POST /consent/accept"]
        S1 -->|Has Consent| S2["Access Learning Platform"]
        S2 --> S3["Start / Stop Session"]
        S3 --> S3A["POST /session/start"]
        S3 --> S3B["POST /session/stop"]
        S3A --> S4["Capture Emotions"]
        S4 --> S4A["POST /predict"]
        S4A --> S4B["POST /emotion/log"]
        S4B --> S4C["Emotion Data Stored"]
        S2 --> S5["View Assigned Materials"]
        S5 --> S5A["GET /materials"]
        S5 --> S5B["POST /materials/{id}/open"]
        S5 --> S5C["POST /materials/{id}/comments"]
        S5 --> S5D["GET /materials/{id}/comments"]
        S5 --> S5E["GET /materials/last-opened"]
        S2 --> S6["Student Dashboard Stats"]
        S6 --> S6A["GET /student/dashboard"]
    end

    subgraph Teacher[Teacher User Flow]
        T0["Teacher Dashboard"] --> T1["Manage Materials"]
        T1 --> T1A["POST /materials/upload"]
        T1 --> T1B["PUT /materials/{id}"]
        T1 --> T1C["POST /materials/{id}/assign"]
        T1 --> T1D["GET /materials"]
        T1 --> T1E["POST /materials/{id}/comments"]
        T1 --> T1F["GET /materials/{id}/comments"]
        T0 --> T2["Monitor Students"]
        T2 --> T2A["GET /teacher/dashboard"]
        T2A --> T2B["Query Emotion Logs"]
        T2A --> T2C["Calculate Statistics"]
        T2 --> T2D["GET /teacher/{id}/class_report"]
    end

    subgraph Admin[Admin User Flow]
        A0["Admin Dashboard"] --> A1["Platform Oversight"]
        A1 --> A1A["GET /admin/stats"]
        A1 --> A1B["GET /admin/activity"]
        A1 --> A1C["PATCH /admin/users/{id}/active"]
        A1 --> A1D["GET /admin/export.csv"]
        A1A --> A1A1["User Statistics"]
        A1A --> A1A2["Material Statistics"]
        A1A --> A1A3["Emotion Log Statistics"]
        A1B --> A1B1["Audit Logs"]
        A1B --> A1B2["Session History"]
        A1B --> A1B3["Activity Summary"]
        A1D --> A1D1["Export Emotion Data"]
        A1D --> A1D2["Export Summary Stats"]
    end

    S4C --> J["Database Storage"]
    S5A --> J
    S5C --> J
    S1A --> O["Consent Record"]
    O --> J
    T1A --> J
    T1B --> J
    T1C --> J
    T1E --> J
    T2A --> J
    A1A --> J
    A1B --> J
    A1C --> J
    A1D --> J

    K["Model Service"] -.->|Image Processing| S4A
    S4A --> M["Emotion Prediction"]
    M --> N["Valence & Arousal Values"]
```

## Endpoint Summary by Role

### Authentication
- `POST /auth/register` - User registration
- `POST /auth/login` - User login
- `GET /auth/me` - Get current user info
- `POST /auth/password-reset-request` - Password reset request

### Consent Management
- `GET /consent/me` - Get user consent status
- `POST /consent/accept` - Accept consent
- `POST /consent/withdraw` - Withdraw consent

### Student Endpoints
- `POST /predict` - Upload image for emotion prediction
- `POST /emotion/log` - Log emotion data
- `POST /session/start` - Start learning session
- `POST /session/stop` - Stop learning session
- `GET /materials` - List assigned materials
- `POST /materials/{id}/open` - Record material opened
- `GET /materials/last-opened` - Get last accessed material
- `POST /materials/{id}/comments` - Add comment to material
- `GET /materials/{id}/comments` - Get material comments
- `GET /student/dashboard` - View personal emotion dashboard

### Teacher Endpoints
- `POST /materials/upload` - Upload learning material
- `PUT /materials/{id}` - Update material
- `POST /materials/{id}/assign` - Assign material to student
- `GET /materials` - List own materials
- `POST /materials/{id}/comments` - Comment on material
- `GET /materials/{id}/comments` - View material comments
- `GET /teacher/dashboard` - View class emotion analytics
- `GET /teacher/{id}/class_report` - Compatibility endpoint

### Admin Endpoints
- `GET /admin/stats` - Platform statistics
- `GET /admin/activity` - Activity logs and audit trail
- `PATCH /admin/users/{id}/active` - Toggle user active status
- `GET /admin/export.csv` - Export all data to CSV

### Utility Endpoints
- `GET /health` - Health check
- `GET /` - Login page
- `GET /student` - Student dashboard page
- `GET /teacher` - Teacher dashboard page

## Data Models

```mermaid
erDiagram
    USER ||--o{ SESSION : starts
    USER ||--o{ EMOTIONLOG : creates
    USER ||--o{ LEARNINGMATERIAL : uploads
    USER ||--o{ MATERIALASSIGNMENT : receives
    USER ||--o{ MATERIALCOMMENT : writes
    USER ||--o{ MATERIALACTIVITY : performs
    USER ||--o{ CONSENTRECORD : accepts
    USER ||--o{ ADMINAUDITLOG : triggers
    
    SESSION ||--o{ EMOTIONLOG : contains
    SESSION ||--o| LEARNINGMATERIAL : uses
    
    LEARNINGMATERIAL ||--o{ MATERIALASSIGNMENT : assigned-to
    LEARNINGMATERIAL ||--o{ MATERIALCOMMENT : has
    LEARNINGMATERIAL ||--o{ MATERIALACTIVITY : tracked
    
    MATERIALCOMMENT ||--o{ MATERIALCOMMENT : replies-to
```

## Key Flows

### Emotion Capture Flow
```mermaid
sequenceDiagram
    participant Student
    participant Client
    participant API
    participant Model
    participant DB
    
    Student->>Client: Upload Image
    Client->>API: POST /predict
    API->>Model: Process Image
    Model-->>API: Valence & Arousal
    API-->>Client: Prediction Results
    Client->>API: POST /emotion/log
    API->>DB: Store Emotion Data
    DB-->>API: Success
    API-->>Client: Log Stored
```

### Material Assignment Flow
```mermaid
sequenceDiagram
    participant Teacher
    participant API
    participant DB
    participant Student
    
    Teacher->>API: POST /materials/upload
    API->>DB: Create Material
    DB-->>API: Material Created
    API-->>Teacher: Material ID
    Teacher->>API: POST /materials/{id}/assign
    API->>DB: Create Assignment
    DB-->>API: Assignment Created
    API-->>Teacher: Success
    Student->>API: GET /materials
    API->>DB: Query Assignments
    DB-->>API: Materials
    API-->>Student: Material List
```

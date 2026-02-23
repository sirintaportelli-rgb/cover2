# 📋 CoverBoard

**School Timetable & Cover Management System**

A web application that helps schools manage teacher absences and cover assignments with three solver tiers (Free, Premium, Intelligent) and an optimiser for fair cover allocation.

---

## 🚀 Deploy to Vercel (Recommended — Free)

### Prerequisites
- A **GitHub** account (free at [github.com](https://github.com))
- A **Vercel** account (free at [vercel.com](https://vercel.com) — sign up with GitHub)

### Option A: Deploy via GitHub (Easiest)

1. **Create a GitHub repository**
   - Go to [github.com/new](https://github.com/new)
   - Name it `coverboard` (or anything you like)
   - Set it to **Public** or **Private**
   - Click **Create repository**

2. **Upload the project files**
   - On your new repository page, click **"uploading an existing file"**
   - Drag and drop ALL the files and folders from this project:
     ```
     coverboard/
     ├── public/
     │   └── index.html
     ├── src/
     │   ├── App.js
     │   └── index.js
     ├── .gitignore
     ├── package.json
     └── README.md
     ```
   - Click **Commit changes**

3. **Deploy on Vercel**
   - Go to [vercel.com/new](https://vercel.com/new)
   - Click **Import** next to your `coverboard` repository
   - Vercel will auto-detect it's a React app
   - Click **Deploy**
   - Wait 1-2 minutes for the build
   - You'll get a live URL like `coverboard-abc123.vercel.app`

4. **Done!** Share the URL with your school. Every time you update the GitHub repo, Vercel automatically redeploys.

### Option B: Deploy via Command Line

If you have **Node.js** (v18+) and **Git** installed:

```bash
# 1. Navigate into the project folder
cd coverboard

# 2. Install dependencies
npm install

# 3. Test locally (opens http://localhost:3000)
npm start

# 4. Install Vercel CLI
npm install -g vercel

# 5. Deploy
vercel

# Follow the prompts — it will give you a live URL
```

---

## 🌐 Custom Domain (Optional)

1. Buy a domain (e.g. `coverboard.co.uk`) from [Namecheap](https://namecheap.com) or [Google Domains](https://domains.google) (~£8-12/year)
2. In your Vercel dashboard, go to your project → **Settings** → **Domains**
3. Add your domain and follow the DNS instructions
4. Vercel provides free HTTPS automatically

---

## 📁 CSV File Formats

CoverBoard requires two CSV files to set up. Download templates from the setup screen.

### Teachers CSV (Required)
```
Name, Subject
Ms Johnson, English
Mr Smith, Maths
Dr Patel, Science
```

### Timetable CSV (Required)
```
Class, Day, Period, Subject, Teacher, Room
7A, Monday, P1, English, Ms Johnson, R101
7A, Monday, P2, Maths, Mr Smith, R102
7B, Monday, P1, Science, Dr Patel, L201
```

### Period Times CSV (Optional)
```
Period, Start, End
P1, 08:45, 09:35
P2, 09:35, 10:25
```

### Terms CSV (Optional)
```
Term Name, Start Week, End Week
Autumn 1, 1, 7
Autumn 2, 8, 14
Spring 1, 15, 20
```

---

## ✨ Features

### 📋 Free Solver
- Finds available teachers per period
- Configurable weekly cover limits per teacher
- Assigns by fairness (fewest covers first)

### ⚡ Premium Solver
- Subject-matched cover preference
- Sixth form class exclusion
- Minimum free periods protection (PPA)
- Exclude teachers who covered yesterday
- Maximum weekly capacity enforcement
- CSV import/export for rules

### 🧠 Intelligent Solver
- Absence probability forecasting (Poisson / Negative Binomial)
- Reserve management for scarce periods
- Strategic weekly optimisation (use concentrated frees first, save valuable teachers for later)
- Weekly risk overview

### 📐 Cover Optimiser
- Logarithmic allocation: `base × ln(1 + frees) × spreadFactor × termWeeks`
- Spread factor rewards evenly distributed free periods
- Visual allocation chart with heatmaps
- One-click apply to weekly limits
- CSV export of allocations

---

## 🛠 Development

```bash
npm install    # Install dependencies
npm start      # Run locally at http://localhost:3000
npm run build  # Create production build in /build folder
```

---

## 📝 Licence

Built for school use. Free to modify and deploy.

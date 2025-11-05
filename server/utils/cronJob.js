import cron from "node-cron"
import { pool } from "../config/database.js";
import { 
sendPlanConfirmationEmail,
sendReminderEmail, 
sendCountdownEmail } from "./emailService.js";


// -----------------------------------------------------------------------------
// JOB 1: DEADLINE CHECKER & PLAN FINALIZER 
// Runs every minute to check for plans past their deadline.
// -----------------------------------------------------------------------------
cron.schedule("* * * * *", async () => {
    console.log("--------------------------testing cron execution--------------------------");
    const startTime = Date.now();
    try {
        console.log("------------Searching for pending groups with passed deadlines------------");
        const planResult = await pool.query(`
            SELECT id, deadline, title, time
            FROM plans
            WHERE status = 'pending'
            ORDER BY deadline ASC
            `);

        for( let plan of planResult.rows){      
            if(new Date(plan.deadline) > new Date()) {
                break;
            }
            try{
                await pool.query('BEGIN');

                const mostVotedDateID = await pool.query(`
                    SELECT plan_date_id, count(*) AS vote_count
                    FROM date_votes
                    WHERE plan_id = $1
                    GROUP BY plan_date_id
                    ORDER BY vote_count DESC
                    LIMIT 1
                `,[plan.id]);
                

                const mostVotedDate = await pool.query(`
                    SELECT date
                    FROM plan_dates
                    WHERE id = $1
                    `, [mostVotedDateID.rows[0].plan_date_id]);

                const confirmedDate = mostVotedDate.rows[0].date;

                await pool.query(`
                    UPDATE plan_dates
                    SET is_confirmed = TRUE
                    WHERE plan_id = $1 AND date = $2
                    `, [plan.id, confirmedDate]);
                

                const mostVotedActivity = await pool.query(`
                    SELECT activity_id, name, location, count(*) AS vote_count
                    FROM activity_votes
                    JOIN activities ON activity_votes.activity_id = activities.id
                    WHERE activities.plan_id = $1
                    GROUP BY activity_id, name, location
                    ORDER BY vote_count DESC
                    LIMIT 1
                    `, [plan.id]);
                

                const confirmedActivity = mostVotedActivity.rows[0];
                //update plan status
                await pool.query(`
                  UPDATE activities
                    SET is_confirmed = TRUE
                    WHERE plan_id = $1 AND id = $2
                    `, [plan.id, confirmedActivity.activity_id]);

                
                await pool.query(`
                    UPDATE plans
                    SET status = 'confirmed', updated_at = NOW(), confirmed_date = $2, confirmed_activity_id = $3
                    WHERE id = $1
                    `, [plan.id, confirmedDate, confirmedActivity.activity_id]);

                await pool.query('COMMIT');
                console.log(`Plan ${plan.id} updated.`);


                try {
                    //send to participants
                    const participants = await pool.query(`
                        SELECT u.email, i.invite_token
                        FROM invitations i
                        JOIN users u ON i.invitee_id = u.id
                        WHERE i.plan_id = $1 AND i.status = 'responded'
                    `, [plan.id]); 

                    for (const participant of participants.rows) {
                        const { email, invite_token } = participant;
                        await sendPlanConfirmationEmail(email, plan, confirmedDate, confirmedActivity, invite_token);
                    }
                    console.log(`Sent ${participants.rowCount} participant confirmations.`);
                    //send to host 
                    // 2. Send to Host 
                    const hostResult = await pool.query(`SELECT email FROM users WHERE id = $1`, [plan.host_id]);
                    if (hostResult.rowCount > 0) {
                        const hostEmail = hostResult.rows[0].email;
                        await sendPlanConfirmationEmail(hostEmail, plan, confirmedDate, confirmedActivity, null, true); // Pass true for isHost
                        console.log(`Sent host confirmation to ${hostEmail}.`);
                    }
                }
                catch (err) {
                    console.log("Error fetching participant emails or sending emails:", err);
                }

            }
            catch(err){
                console.log("----------------------Cron Error----------------------");
                await pool.query('ROLLBACK');
                console.log(`Plan ${plan.id} failed and rolled back.`)
                console.log(err);
            }
        };
        
    }
    catch(err){
        console.log("----------------------Cron Error----------------------");
        console.log("Cron job failed while looking for plans whos deadline passed.", err);
    }
    finally {
        const endTime = Date.now();
        const timeTaken = endTime - startTime;
        console.log(`------------------Cron job took ${timeTaken} ms------------------`);
    }
});
// -----------------------------------------------------------------------------
// JOB 2: DAILY REMINDER SENDER
// Runs every day at 9:00 AM.
// -----------------------------------------------------------------------------
cron.schedule("0 9 * * *", async () => {
  console.log("--------------------------[CRON 2/3: Daily Reminder]--------------------------");
  try {
    const invitesResult = await pool.query(
      `SELECT
         i.email, i.invite_token,
         p.title, p.deadline
       FROM invitations i
       JOIN plans p ON i.plan_id = p.id
       WHERE i.status = 'pending'
       AND p.status = 'pending'
       AND p.deadline > NOW()`
    );

    if (invitesResult.rowCount === 0) {
      console.log("No pending invitations to remind today.");
      return;
    }

    console.log(`Sending ${invitesResult.rowCount} reminder emails...`);
    for (const invite of invitesResult.rows) {
      const inviteLink = `${process.env.FRONTEND_URL}/respond/${invite.invite_token}`;
      await sendReminderEmail(invite.email, invite.title, invite.deadline, inviteLink);
    }
    console.log("All reminders sent.");
  
  } catch (err) {
    console.log("----------------------Cron 2 Error----------------------");
    console.log("Cron job failed while sending reminders.", err);
  }
});

// -----------------------------------------------------------------------------
// JOB 3: COUNTDOWN EMAIL SENDER
// Runs every day at 8:00 AM.
// -----------------------------------------------------------------------------
cron.schedule("0 8 * * *", async () => {
  console.log("--------------------------[CRON 3/3: Countdown Sender]--------------------------");
  const milestones = [7, 3, 2, 1, 0]; // Days remaining

  try {
    for (const days of milestones) {
      // Find plans that are exactly 'days' away from today
      const plansResult = await pool.query(
        `SELECT
           p.id, p.title, p.time, p.confirmed_date, p.host_id,
           a.name AS activity_name, a.location AS activity_location
         FROM plans p
         JOIN activities a ON p.confirmed_activity_id = a.id
         WHERE p.status = 'confirmed'
         AND p.confirmed_date = (CURRENT_DATE + INTERVAL '${days} days')`
      );

      if (plansResult.rowCount > 0) {
        console.log(`Found ${plansResult.rowCount} plans for ${days}-day countdown.`);
        for (const plan of plansResult.rows) {
          const activity = { name: plan.activity_name, location: plan.activity_location };

          // Get all recipients (host + responded invitees)
          const participantsResult = await pool.query(
            `SELECT u.email FROM invitations i
             JOIN users u ON i.invitee_id = u.id
             WHERE i.plan_id = $1 AND i.status = 'responded'`,
            [plan.id]
          );
          const hostResult = await pool.query(`SELECT email FROM users WHERE id = $1`, [plan.host_id]);
          
          const recipients = participantsResult.rows.map(p => p.email);
          if (hostResult.rowCount > 0) {
            recipients.push(hostResult.rows[0].email);
          }
          
          // Remove duplicates (in case host was also invited)
          const uniqueRecipients = [...new Set(recipients)];

          console.log(`Sending ${days}-day countdown for plan ${plan.id} to ${uniqueRecipients.length} recipients.`);
          for (const email of uniqueRecipients) {
            await sendCountdownEmail(email, plan, activity, days);
          }
        }
      }
    }
    console.log("Countdown email job complete.");
  } catch (err) {
    console.log("----------------------Cron 3 Error----------------------");
    console.log("Cron job failed while sending countdowns.", err);
  }
});
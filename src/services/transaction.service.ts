import prisma from "../lib/prisma";
import { transaction_status } from "@prisma/client";
import {
  ICreateTransactionParam,
  IPaymentTransactionParam,
  IEOActionTransactionParam,
} from "../interfaces/transaction.interface";
import { cloudinaryRemove, cloudinaryUpload } from "../utils/cloudinary";

import path from "path";
import fs from "fs";
import { transporter } from "../utils/nodemailer";
import handlebars from "handlebars";

//Create Transaction (Click "BuyTicket" Button from event details page)
async function CreateTransactionService(param: ICreateTransactionParam) {
  const { userId, eventId, quantity, couponId, voucherId, pointsId } = param;

  // 1. Fetch Event & User
  const [event, user] = await Promise.all([
    prisma.event.findUnique({ where: { id: eventId } }),
    prisma.user.findUnique({ where: { id: userId } }),
  ]);
  if (!event) throw new Error("Event not found");
  if (!user) throw new Error("User not found");

  // 2. Check seat availability
  if (event.remaining_seats < quantity) {
    throw new Error("Not enough seats available");
  }

  const now = new Date();

  // 3. Gather discounts
  let couponDiscount = 0;
  let voucherDiscount = 0;
  let pointsDiscount = 0;

  // 3a. Coupon
  if (couponId) {
    const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
    if (
      !coupon ||
      coupon.user_id !== userId ||
      now < coupon.coupon_start_date ||
      now > coupon.coupon_end_date ||
      coupon.use_count >= coupon.max_usage
    ) {
      throw new Error("Invalid or expired coupon");
    }
    couponDiscount = coupon.discount_amount;
  }

  // 3b. Voucher
  if (voucherId) {
    const voucher = await prisma.voucher.findUnique({
      where: { id: voucherId },
    });
    if (
      !voucher ||
      voucher.event_id !== eventId ||
      now < voucher.voucher_start_date ||
      now > voucher.voucher_end_date ||
      voucher.usage_amount >= voucher.max_usage
    ) {
      throw new Error("Invalid or expired voucher");
    }
    voucherDiscount = voucher.discount_amount;
  }

  // 3c. Points
  if (pointsId) {
    const points = await prisma.points.findUnique({ where: { id: pointsId } });
    if (
      !points ||
      points.user_id !== userId ||
      points.is_used ||
      points.is_expired ||
      now > points.expires_at
    ) {
      throw new Error("Invalid or expired points");
    }
    pointsDiscount = points.points_amount;
  }

  // 4. Calculate payment
  const originalAmount = event.price * quantity;
  const totalDiscount = couponDiscount + voucherDiscount + pointsDiscount;
  const finalAmount = Math.max(0, originalAmount - totalDiscount);

  // 5. Determine initial status & expiration
  let status: transaction_status;
  let expiresAt: Date;
  if (event.price === 0) {
    status = transaction_status.confirmed;
    expiresAt = now; // immediate
  } else {
    status = transaction_status.waiting_for_payment;
    expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2 hours
  }

  // 6. Create transaction + side effects in one atomic call
  const tx = await prisma.$transaction(async (tx) => {
    // 6a. Create transaction
    const transaction = await tx.transaction.create({
      data: {
        user_id: userId,
        event_id: eventId,
        quantity,
        unit_price: event.price,
        total_pay_amount: finalAmount,
        payment_proof: null,
        status,
        expires_at: expiresAt,
        coupon_id: couponId ?? undefined,
        voucher_id: voucherId ?? undefined,
        points_id: pointsId ?? undefined,
      },
    });

    // 6b. Decrement seats
    await tx.event.update({
      where: { id: eventId },
      data: { remaining_seats: event.remaining_seats - quantity },
    });

    // 6c. Increment coupon usage
    if (couponId) {
      await tx.coupon.update({
        where: { id: couponId },
        data: { use_count: { increment: 1 } },
      });
    }

    // 6d. Increment voucher usage
    if (voucherId) {
      await tx.voucher.update({
        where: { id: voucherId },
        data: { usage_amount: { increment: 1 } },
      });
    }

    // 6e. Mark points used
    if (pointsId) {
      await tx.points.update({
        where: { id: pointsId },
        data: {
          is_used: true,
        },
      });
    }

    return transaction;
  });

  return tx;
}

//Customer upload Payment Proof, and then change the status to "waiting_for_admin_confirmation"
async function PaymentTransactionService({
  transactionId,
  userId,
  file,
}: IPaymentTransactionParam) {
  let url = "";
  try {
    // 1. Get the transaction
    const tx = await prisma.transaction.findUnique({
      where: { id: transactionId },
    });

    if (!tx) {
      throw new Error("Transaction not found");
    }

    // 2. Check ownership
    if (tx.user_id !== userId) {
      throw new Error("You are not authorized to confirm this transaction");
    }

    // 3. Must be in the correct status
    if (tx.status !== transaction_status.waiting_for_payment) {
      throw new Error("Transaction is not awaiting payment");
    }

    // 4. Check if expired
    if (tx.expires_at && tx.expires_at < new Date()) {
      await prisma.transaction.update({
        where: { id: transactionId },
        data: { status: transaction_status.expired },
      });

      throw new Error("Transaction has expired");
    }

    // 5. Upload to Cloudinary
    const { secure_url } = await cloudinaryUpload(file);
    url = secure_url;
    const splitUrl = secure_url.split("/");
    const fileName = splitUrl[splitUrl.length - 1];

    // 6. Wrap database update inside $transaction
    const updatedTx = await prisma.$transaction(async (txClient) => {
      // Update transaction with payment proof and status inside the transaction
      const updatedTransaction = await txClient.transaction.update({
        where: { id: transactionId },
        data: {
          payment_proof: fileName, // Save the secure URL in the database
          status: transaction_status.waiting_for_admin_confirmation,
          updated_at: new Date(),
        },
      });

      return updatedTransaction;
    });

    return updatedTx;
  } catch (err) {
    if (url) await cloudinaryRemove(url);
    throw err;
  }
}

//Event Organizer Action Confirm or Reject
async function EOActionTransactionService(param: IEOActionTransactionParam) {
  try {
    const { transactionId, userId, action } = param;

    // Fetch the transaction along with its event to ensure the EO is authorized to act
    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: {
        event: true,
        user: {
          select: {
            username: true,
            email: true,
          },
        },
      },
    });

    if (!transaction) throw new Error("Transaction not found");

    const event = transaction.event;

    // Ensure the transaction belongs to the correct event organizer
    if (event.organizer_id !== userId) {
      throw new Error("You are not authorized to modify this transaction");
    }

    // Check the current status of the transaction
    if (
      transaction.status !== transaction_status.waiting_for_admin_confirmation
    ) {
      throw new Error(
        "Transaction status is not waiting for admin confirmation"
      );
    }

    // Use the action from the enum directly
    let updatedStatus: transaction_status;
    if (
      action === transaction_status.confirmed ||
      action === transaction_status.rejected
    ) {
      updatedStatus = action; // Directly using the action from the enum
    } else {
      throw new Error("Invalid action");
    }

    // If rejecting, perform rollback in a transaction
    if (updatedStatus === transaction_status.rejected) {
      return await prisma.$transaction(async (txClient) => {
        // a) Restore seats
        await txClient.event.update({
          where: { id: transaction.event_id },
          data: { remaining_seats: { increment: transaction.quantity } },
        });

        // b) Refund coupon usage
        if (transaction.coupon_id) {
          await txClient.coupon.update({
            where: { id: transaction.coupon_id },
            data: { use_count: { decrement: 1 } },
          });
        }

        // c) Refund voucher usage
        if (transaction.voucher_id) {
          await txClient.voucher.update({
            where: { id: transaction.voucher_id },
            data: { usage_amount: { decrement: 1 } },
          });
        }

        // d) Mark points unused
        if (transaction.points_id) {
          await txClient.points.update({
            where: { id: transaction.points_id },
            data: { is_used: false },
          });
        }

        // e) Update the transaction status
        const updatedTransaction = await txClient.transaction.update({
          where: { id: transactionId },
          data: {
            status: updatedStatus,
            updated_at: new Date(),
          },
        });

        // Replace template with hardcoded HTML
        const htmlContent = `
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>Transaction Rejected</title>
          </head>
          <body>
            <div
              style="font-family: sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;"
            >
              <div style="text-align: center; margin-bottom: 20px;">
                <h2 style="color: #e53e3e;">Transaction Rejected</h2>
              </div>

              <div
                style="background-color: #f8f8f8; border-radius: 8px; padding: 20px; margin-bottom: 20px;"
              >
                <p>Hi ${transaction.user.username},</p>
                <p>We regret to inform you that your transaction for
                  <strong>${transaction.event.name}</strong>
                  has been rejected by the event organizer.</p>

                <div
                  style="background-color: #fff; border-left: 4px solid #e53e3e; padding: 15px; margin: 15px 0;"
                >
                  <p style="margin: 0;"><strong>Transaction ID:</strong>
                    ${transaction.id}</p>
                  <p style="margin: 8px 0 0;"><strong>Rejection Reason:</strong>
                    Your transaction has been rejected</p>
                </div>

                <p>Any points, vouchers, or coupons used for this transaction have been
                  returned to your account. The seats you reserved have also been made
                  available again.</p>
              </div>

              <div style="margin: 24px 0; text-align: center;">
                <a
                  href="https://yourdomain.com/my-transactions"
                  style="background-color: #4F46E5; color: white; padding: 12px 20px; text-decoration: none; border-radius: 6px; display: inline-block;"
                >
                  View My Transactions
                </a>
              </div>

              <div
                style="margin-top: 30px; border-top: 1px solid #eee; padding-top: 20px; font-size: 14px; color: #666;"
              >
                <p>If you have any questions about this rejection, please contact the
                  event organizer directly or reply to this email for assistance.</p>
                <p>Thank you for using our platform.</p>
                <p>Best regards,<br /><strong>Ticket Team</strong></p>
              </div>
            </div>
          </body>
        </html>`;

        await transporter.sendMail({
          from: '"Ticket Admin" <no-reply@yourdomain.com>',
          to: transaction.user.email,
          subject: "Transaction Rejected",
          html: htmlContent,
        });

        return updatedTransaction;
      });
    } else {
      // For confirmation, update the status and send confirmation email
      const updatedTransaction = await prisma.transaction.update({
        where: { id: transactionId },
        data: {
          status: updatedStatus,
          updated_at: new Date(),
        },
        include: {
          event: true,
          user: {
            select: {
              username: true,
              email: true,
            },
          },
        },
      });

      // Send confirmation email
      const htmlContent = `
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Transaction Confirmed</title>
        </head>
        <body>
          <div
            style="font-family: sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;"
          >
            <div style="text-align: center; margin-bottom: 20px;">
              <h2 style="color: #10b981;">Transaction Confirmed</h2>
            </div>

            <div
              style="background-color: #f8f8f8; border-radius: 8px; padding: 20px; margin-bottom: 20px;"
            >
              <p>Hi ${updatedTransaction.user.username},</p>
              <p>Great news! Your transaction for
                <strong>${updatedTransaction.event.name}</strong>
                has been confirmed by the event organizer.</p>

              <div
                style="background-color: #fff; border-left: 4px solid #10b981; padding: 15px; margin: 15px 0;"
              >
                <p style="margin: 0;"><strong>Transaction ID:</strong>
                  ${updatedTransaction.id}</p>
                <p style="margin: 8px 0 0;"><strong>Event Date:</strong>
                  ${new Date(
                    updatedTransaction.event.start_date
                  ).toLocaleDateString()}</p>
                <p style="margin: 8px 0 0;"><strong>Quantity:</strong>
                  ${updatedTransaction.quantity} ticket(s)</p>
              </div>

              <p>You're all set! Your tickets are now confirmed and ready for the event.</p>
            </div>

            <div style="margin: 24px 0; text-align: center;">
              <a
                href="https://yourdomain.com/my-tickets"
                style="background-color: #4F46E5; color: white; padding: 12px 20px; text-decoration: none; border-radius: 6px; display: inline-block;"
              >
                View My Tickets
              </a>
            </div>

            <div
              style="margin-top: 30px; border-top: 1px solid #eee; padding-top: 20px; font-size: 14px; color: #666;"
            >
              <p>We look forward to seeing you at the event!</p>
              <p>If you have any questions, please contact the event organizer or reply to this email.</p>
              <p>Best regards,<br /><strong>Ticket Team</strong></p>
            </div>
          </div>
        </body>
      </html>`;

      await transporter.sendMail({
        from: '"Ticket Admin" <no-reply@yourdomain.com>',
        to: updatedTransaction.user.email,
        subject: "Transaction Confirmed",
        html: htmlContent,
      });

      return updatedTransaction;
    }
  } catch (err) {
    throw err;
  }
}

// Expire Transactions that have not received payment proof within 2 hours
async function AutoExpireTransactionService() {
  try {
    console.log("function auto expire berjalan");
    await prisma.transaction.updateMany({
      where: {
        status: transaction_status.waiting_for_payment,
        expires_at: { lt: new Date() },
      },
      data: {
        status: transaction_status.expired,
      },
    });
  } catch (err) {
    throw err;
  }
}

async function AutoCancelTransactionService() {
  try {
    console.log("function auto cancel berjalan");

    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

    // 1. Find all transactions still pending admin confirmation for 3+ days
    const staleTransactions = await prisma.transaction.findMany({
      where: {
        status: transaction_status.waiting_for_admin_confirmation,
        updated_at: { lt: threeDaysAgo },
      },
    });

    // Rollback all transactions
    for (const tx of staleTransactions) {
      await prisma.$transaction(async (txClient) => {
        // a) Restore seats
        await txClient.event.update({
          where: { id: tx.event_id },
          data: { remaining_seats: { increment: tx.quantity } },
        });

        // b) Refund coupon usage
        if (tx.coupon_id) {
          await txClient.coupon.update({
            where: { id: tx.coupon_id },
            data: { use_count: { decrement: 1 } },
          });
        }

        // c) Refund voucher usage
        if (tx.voucher_id) {
          await txClient.voucher.update({
            where: { id: tx.voucher_id },
            data: { usage_amount: { decrement: 1 } },
          });
        }

        // d) Mark points unused
        if (tx.points_id) {
          await txClient.points.update({
            where: { id: tx.points_id },
            data: { is_used: false },
          });
        }

        // e) Finally cancel the transaction
        await txClient.transaction.update({
          where: { id: tx.id },
          data: { status: transaction_status.canceled, updated_at: new Date() },
        });
      });
    }
  } catch (err) {
    throw err;
  }
}

export {
  CreateTransactionService,
  PaymentTransactionService,
  EOActionTransactionService,
  AutoExpireTransactionService,
  AutoCancelTransactionService,
};
